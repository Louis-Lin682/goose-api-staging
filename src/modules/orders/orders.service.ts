import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DeliveryMethod,
  OrderStatus,
  PaymentStatus,
  type PaymentMethod,
  type PaymentProvider,
} from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';

export type CreateOrderResponse = {
  message: string;
  orderId: string;
  orderNumber: string;
};

export type OrderHistoryItem = {
  id: string;
  itemName: string;
  itemCategory: string;
  itemSubCategory: string;
  variant: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  refundedQuantity: number;
};

export type OrderHistoryEntry = {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  paymentProvider: string | null;
  deliveryMethod: string;
  paymentMethod: string;
  recipientName: string;
  recipientPhone: string;
  recipientEmail: string;
  recipientAddress: string | null;
  pickupStoreCode: string | null;
  pickupStoreName: string | null;
  pickupStoreAddress: string | null;
  note: string | null;
  refundedAmount: number;
  refundReason: string | null;
  refundedAt: Date | null;
  subtotal: number;
  shippingFee: number;
  codFee: number;
  totalAmount: number;
  paidAt: Date | null;
  createdAt: Date;
  items: OrderHistoryItem[];
};

export type OrderHistoryResponse = {
  orders: OrderHistoryEntry[];
};

export type UpdateOrderStatusResponse = {
  message: string;
  orderId: string;
  status: string;
};

export type RefundOrderResponse = {
  message: string;
  orderId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  refundedAmount: number;
};

export type AdminProductStatsPreset =
  | 'today'
  | 'this-month'
  | 'last-month'
  | 'custom';

export type AdminProductStatsFilters = {
  preset?: AdminProductStatsPreset;
  startDate?: string;
  endDate?: string;
};

export type AdminProductStatPoint = {
  productKey: string;
  productName: string;
  category: string;
  subCategory: string;
  variant: string;
  quantitySold: number;
  revenue: number;
  orderCount: number;
};

export type AdminProductStatsResponse = {
  range: {
    preset: AdminProductStatsPreset;
    label: string;
    startDate: string;
    endDate: string;
  };
  totalRevenue: number;
  totalOrders: number;
  totalItemsSold: number;
  topProducts: AdminProductStatPoint[];
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async createOrder(
    createOrderDto: CreateOrderDto,
    userId?: string,
  ): Promise<CreateOrderResponse> {
    const normalizedItems = createOrderDto.items.map((item) => ({
      itemId: item.id.trim(),
      itemName: item.name.trim(),
      itemCategory: item.category.trim(),
      itemSubCategory: item.subCategory.trim(),
      variant: item.selectedVariant.trim(),
      unitPrice: item.finalPrice,
      quantity: item.quantity,
      lineTotal: item.finalPrice * item.quantity,
    }));

    const subtotal = normalizedItems.reduce(
      (sum, item) => sum + item.lineTotal,
      0,
    );
    const expectedShippingFee = this.getShippingFee(
      subtotal,
      createOrderDto.deliveryMethod,
    );
    const expectedCodFee = this.getCodFee(
      subtotal,
      createOrderDto.deliveryMethod,
      createOrderDto.paymentMethod,
    );

    if (createOrderDto.shippingFee !== expectedShippingFee) {
      throw new BadRequestException(
        'Shipping fee does not match the expected amount.',
      );
    }

    if (createOrderDto.codFee !== expectedCodFee) {
      throw new BadRequestException(
        'COD fee does not match the expected amount.',
      );
    }

    const orderNumber = this.createOrderNumber();
    const recipientName = createOrderDto.recipientName.trim();
    const recipientPhone = createOrderDto.recipientPhone.trim();
    const recipientEmail = createOrderDto.recipientEmail.trim().toLowerCase();
    const recipientAddress = createOrderDto.recipientAddress?.trim() || null;
    const pickupStoreCode = createOrderDto.pickupStoreCode?.trim() || null;
    const pickupStoreName = createOrderDto.pickupStoreName?.trim() || null;
    const pickupStoreAddress =
      createOrderDto.pickupStoreAddress?.trim() || null;
    const note = createOrderDto.note?.trim() || null;

    if (
      createOrderDto.deliveryMethod === DeliveryMethod.home &&
      !recipientAddress
    ) {
      throw new BadRequestException(
        'Recipient address is required for home delivery.',
      );
    }

    const isConvenienceStorePickup =
      createOrderDto.deliveryMethod === DeliveryMethod.familymart ||
      createOrderDto.deliveryMethod === DeliveryMethod.seven_eleven;

    if (isConvenienceStorePickup) {
      if (!pickupStoreCode || !pickupStoreName || !pickupStoreAddress) {
        throw new BadRequestException(
          'Pickup store code, name, and address are required for convenience-store pickup.',
        );
      }
    }

    const totalAmount = subtotal + expectedShippingFee + expectedCodFee;

    const order = await this.prisma.$transaction(async (tx) => {
      const createdOrder = await tx.order.create({
        data: {
          orderNumber,
          deliveryMethod: createOrderDto.deliveryMethod,
          paymentMethod: createOrderDto.paymentMethod,
          recipientName,
          recipientPhone,
          recipientEmail,
          recipientAddress,
          pickupStoreCode,
          pickupStoreName,
          pickupStoreAddress,
          note,
          subtotal,
          shippingFee: expectedShippingFee,
          codFee: expectedCodFee,
          totalAmount,
          userId,
          items: {
            create: normalizedItems,
          },
        },
      });

      if (userId && recipientAddress) {
        const existingUser = await tx.user.findUnique({
          where: { id: userId },
          select: { address: true },
        });

        if (existingUser && !existingUser.address?.trim()) {
          await tx.user.update({
            where: { id: userId },
            data: { address: recipientAddress },
          });
        }
      }

      return createdOrder;
    });

    if (order.paymentMethod !== 'online') {
      try {
        await this.notificationsService.createNewOrderNotification({
          orderId: order.id,
          orderNumber: order.orderNumber,
          recipientName: order.recipientName,
          totalAmount: order.totalAmount,
        });
      } catch (error) {
        console.error('Failed to create new order notification', error);
      }
    }

    return {
      message: 'Order created successfully',
      orderId: order.id,
      orderNumber: order.orderNumber,
    };
  }

  async getOrderHistory(userId?: string): Promise<OrderHistoryResponse> {
    if (!userId) {
      throw new UnauthorizedException(
        'Please log in first to view order history.',
      );
    }

    const orders = await this.prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return {
      orders: this.mapOrders(orders),
    };
  }

  async getAdminOrders(): Promise<OrderHistoryResponse> {
    const findOrders = () =>
      this.prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          items: {
            orderBy: { createdAt: 'asc' },
          },
        },
        take: 200,
      });

    try {
      const orders = await findOrders();

      return {
        orders: this.mapOrders(orders),
      };
    } catch (error) {
      const errorCode = this.getPrismaErrorCode(error);

      if (errorCode !== 'ETIMEDOUT') {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));

      try {
        const orders = await findOrders();

        return {
          orders: this.mapOrders(orders),
        };
      } catch (retryError) {
        const retryErrorCode = this.getPrismaErrorCode(retryError);

        if (retryErrorCode === 'ETIMEDOUT') {
          return {
            orders: [],
          };
        }

        throw retryError;
      }
    }
  }

  async getAdminProductStats(
    filters: AdminProductStatsFilters,
  ): Promise<AdminProductStatsResponse> {
    const range = this.resolveStatsRange(filters);

    const orders = await this.prisma.order.findMany({
      where: {
        status: {
          not: OrderStatus.CANCELLED,
        },
        createdAt: {
          gte: range.start,
          lte: range.end,
        },
      },
      include: {
        items: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    const productMap = new Map<string, AdminProductStatPoint>();

    for (const order of orders) {
      const countedKeys = new Set<string>();

      for (const item of order.items) {
        const productKey = `${item.itemName}::${item.itemSubCategory}::${item.variant}`;
        const current = productMap.get(productKey);

        if (current) {
          current.quantitySold += item.quantity;
          current.revenue += item.lineTotal;

          if (!countedKeys.has(productKey)) {
            current.orderCount += 1;
          }
        } else {
          productMap.set(productKey, {
            productKey,
            productName: item.itemName,
            category: item.itemCategory,
            subCategory: item.itemSubCategory,
            variant: item.variant,
            quantitySold: item.quantity,
            revenue: item.lineTotal,
            orderCount: 1,
          });
        }

        countedKeys.add(productKey);
      }
    }

    const topProducts = Array.from(productMap.values())
      .sort((left, right) => {
        if (right.quantitySold !== left.quantitySold) {
          return right.quantitySold - left.quantitySold;
        }

        if (right.revenue !== left.revenue) {
          return right.revenue - left.revenue;
        }

        return left.productName.localeCompare(right.productName);
      })
      .slice(0, 10);

    const totalRevenue = orders.reduce(
      (sum, order) => sum + order.totalAmount,
      0,
    );
    const totalItemsSold = orders.reduce(
      (sum, order) =>
        sum + order.items.reduce((itemSum, item) => itemSum + item.quantity, 0),
      0,
    );

    return {
      range: {
        preset: range.preset,
        label: range.label,
        startDate: this.formatDateOnly(range.start),
        endDate: this.formatDateOnly(range.end),
      },
      totalRevenue,
      totalOrders: orders.length,
      totalItemsSold,
      topProducts,
    };
  }

  async updateOrderStatus(
    orderId: string,
    status: OrderStatus,
  ): Promise<UpdateOrderStatusResponse> {
    const existingOrder = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });

    if (!existingOrder) {
      throw new NotFoundException('Order not found.');
    }

    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: { status },
      select: {
        id: true,
        status: true,
      },
    });

    await this.notificationsService.markOrderNotificationsAsRead(orderId);

    return {
      message: 'Order status updated successfully',
      orderId: order.id,
      status: order.status,
    };
  }

  private getPrismaErrorCode(error: unknown): string | null {
    if (!error || typeof error !== 'object' || !('code' in error)) {
      return null;
    }

    const maybeCode = (error as { code?: unknown }).code;
    return typeof maybeCode === 'string' ? maybeCode : String(maybeCode);
  }

  private mapOrders(
    orders: Array<{
      id: string;
      orderNumber: string;
      status: OrderStatus;
      deliveryMethod: DeliveryMethod;
      paymentMethod: PaymentMethod;
      paymentStatus: PaymentStatus;
      paymentProvider: PaymentProvider | null;
      recipientName: string;
      recipientPhone: string;
      recipientEmail: string;
      recipientAddress: string | null;
      pickupStoreCode: string | null;
      pickupStoreName: string | null;
      pickupStoreAddress: string | null;
      note: string | null;`r`n      refundedAmount: number;`r`n      refundReason: string | null;`r`n      refundedAt: Date | null;`r`n      subtotal: number;
      shippingFee: number;
      codFee: number;
      totalAmount: number;
      paidAt: Date | null;
      createdAt: Date;
      items: Array<{
        id: string;
        itemName: string;
        itemCategory: string;
        itemSubCategory: string;
        variant: string;
        unitPrice: number;
        quantity: number;`r`n        refundedQuantity: number;`r`n        lineTotal: number;
      }>;
    }>,
  ): OrderHistoryEntry[] {
    return orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentProvider: order.paymentProvider,
      deliveryMethod: order.deliveryMethod,
      paymentMethod: order.paymentMethod,
      recipientName: order.recipientName,
      recipientPhone: order.recipientPhone,
      recipientEmail: order.recipientEmail,
      recipientAddress: order.recipientAddress,
      pickupStoreCode: order.pickupStoreCode,
      pickupStoreName: order.pickupStoreName,
      pickupStoreAddress: order.pickupStoreAddress,
      note: order.note,
      subtotal: order.subtotal,
      refundedAmount: order.refundedAmount,
      refundReason: order.refundReason,
      refundedAt: order.refundedAt,
      shippingFee: order.shippingFee,
      codFee: order.codFee,
      totalAmount: order.totalAmount,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
      items: order.items.map((item) => ({
        id: item.id,
        itemName: item.itemName,
        itemCategory: item.itemCategory,
        itemSubCategory: item.itemSubCategory,
        variant: item.variant,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        refundedQuantity: item.refundedQuantity,
        lineTotal: item.lineTotal,
      })),
    }));
  }

  private resolveStatsRange(filters: AdminProductStatsFilters) {
    const normalizedPreset = this.normalizePreset(filters.preset);

    if (filters.startDate && filters.endDate) {
      const start = this.parseDateBoundary(filters.startDate, 'start');
      const end = this.parseDateBoundary(filters.endDate, 'end');

      if (start > end) {
        throw new BadRequestException(
          'Start date cannot be later than end date.',
        );
      }

      return {
        preset: normalizedPreset,
        label: this.getRangeLabel(normalizedPreset),
        start,
        end,
      };
    }

    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0,
    );
    const todayEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999,
    );

    if (normalizedPreset === 'today') {
      return {
        preset: normalizedPreset,
        label: this.getRangeLabel(normalizedPreset),
        start: todayStart,
        end: todayEnd,
      };
    }

    if (normalizedPreset === 'this-month') {
      return {
        preset: normalizedPreset,
        label: this.getRangeLabel(normalizedPreset),
        start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
        end: todayEnd,
      };
    }

    const lastMonthStart = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      1,
      0,
      0,
      0,
      0,
    );
    const lastMonthEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      0,
      23,
      59,
      59,
      999,
    );

    return {
      preset: normalizedPreset,
      label: this.getRangeLabel(normalizedPreset),
      start: lastMonthStart,
      end: lastMonthEnd,
    };
  }

  private normalizePreset(
    preset?: AdminProductStatsPreset,
  ): AdminProductStatsPreset {
    switch (preset) {
      case 'this-month':
      case 'last-month':
      case 'custom':
      case 'today':
        return preset;
      default:
        return 'today';
    }
  }

  private getRangeLabel(preset: AdminProductStatsPreset) {
    switch (preset) {
      case 'today':
        return '?????';
      case 'this-month':
        return '???';
      case 'last-month':
        return '????';
      case 'custom':
        return '???????';
      default:
        return '?????';
    }
  }

  private parseDateBoundary(value: string, boundary: 'start' | 'end') {
    const date = new Date(`${value}T00:00:00.000`);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date range.');
    }

    if (boundary === 'end') {
      date.setHours(23, 59, 59, 999);
    }

    return date;
  }

  private formatDateOnly(value: Date) {
    const year = value.getFullYear();
    const month = `${value.getMonth() + 1}`.padStart(2, '0');
    const day = `${value.getDate()}`.padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  private getShippingFee(subtotal: number, deliveryMethod: DeliveryMethod) {
    if (deliveryMethod === DeliveryMethod.pickup) {
      return 0;
    }

    if (subtotal <= 1000) {
      return 200;
    }

    if (subtotal <= 1800) {
      return 230;
    }

    if (subtotal <= 6000) {
      return 290;
    }

    return 0;
  }

  private getCodFee(
    subtotal: number,
    deliveryMethod: DeliveryMethod,
    paymentMethod: PaymentMethod,
  ) {
    if (paymentMethod !== 'cod') {
      return 0;
    }

    if (deliveryMethod === DeliveryMethod.pickup) {
      return 0;
    }

    if (subtotal <= 1800) {
      return 30;
    }

    if (subtotal <= 6000) {
      return 60;
    }

    if (subtotal <= 10000) {
      return 90;
    }

    return 0;
  }

  private createOrderNumber() {
    const date = new Date();
    const yyyymmdd = `${date.getFullYear()}${`${date.getMonth() + 1}`.padStart(2, '0')}${`${date.getDate()}`.padStart(2, '0')}`;
    const suffix = `${Math.floor(Math.random() * 100000)}`.padStart(5, '0');

    return `GO${yyyymmdd}${suffix}`;
  }
}



