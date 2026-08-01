import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from '@prisma/client';
import { createHash } from 'crypto';
import { RefundOrderDto, RefundRequestMode } from '../orders/dto/refund-order.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';

type EcpayCheckoutFieldMap = Record<string, string>;

export type EcpayCheckoutResponse = {
  action: string;
  method: 'POST';
  fields: EcpayCheckoutFieldMap;
};

@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly unpaidOrderTimeoutInMs = 30 * 60 * 1000;
  private readonly unpaidOrderSweepIntervalInMs = 5 * 60 * 1000;
  private readonly merchantId: string;
  private readonly hashKey: string;
  private readonly hashIv: string;
  private readonly checkoutAction: string;
  private readonly refundAction: string;
  private readonly backendBaseUrl: string;
  private readonly frontendBaseUrl: string;
  private unpaidOrderSweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly notificationsService: NotificationsService,
  ) {
    this.merchantId =
      this.configService.get<string>('ECPAY_MERCHANT_ID') ?? '2000132';
    this.hashKey =
      this.configService.get<string>('ECPAY_HASH_KEY') ?? '5294y06JbISpM5x9';
    this.hashIv =
      this.configService.get<string>('ECPAY_HASH_IV') ?? 'v77hoKGq4kWxNNIS';
    this.checkoutAction =
      this.configService.get<string>('ECPAY_CHECKOUT_ACTION') ??
      'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5';
    this.refundAction =
      this.configService.get<string>('ECPAY_REFUND_ACTION') ??
      'https://payment-stage.ecpay.com.tw/CreditDetail/DoAction';

    const port = this.configService.get<string>('PORT') ?? '3001';
    this.backendBaseUrl =
      this.configService.get<string>('BACKEND_BASE_URL') ??
      `http://localhost:${port}`;
    this.frontendBaseUrl =
      this.configService
        .get<string>('FRONTEND_APP_URL')
        ?.split(',')[0]
        ?.trim() ||
      this.configService
        .get<string>('FRONTEND_ORIGIN')
        ?.split(',')[0]
        ?.trim() ||
      'http://localhost:5173';
  }

  onModuleInit(): void {
    // Keep abandoned online-payment orders from staying payable forever.
    void this.cancelExpiredUnpaidOrders();
    this.unpaidOrderSweepTimer = setInterval(() => {
      void this.cancelExpiredUnpaidOrders();
    }, this.unpaidOrderSweepIntervalInMs);
  }

  onModuleDestroy(): void {
    if (this.unpaidOrderSweepTimer) {
      clearInterval(this.unpaidOrderSweepTimer);
      this.unpaidOrderSweepTimer = null;
    }
  }

  async createEcpayCheckout(
    orderId: string,
    userId?: string,
  ): Promise<EcpayCheckoutResponse> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    if (!userId) {
      throw new ForbiddenException('請先登入會員，再建立付款。');
    }

    if (!order.userId || order.userId !== userId) {
      throw new ForbiddenException('這筆訂單不屬於目前登入的會員。');
    }

    if (order.paymentMethod !== PaymentMethod.online) {
      throw new BadRequestException('只有線上付款訂單才能建立綠界付款。');
    }

    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException('這筆訂單已完成付款。');
    }

    if (!this.merchantId || !this.hashKey || !this.hashIv) {
      throw new InternalServerErrorException('綠界金流尚未完成設定。');
    }

    // Reuse the plain order number for the first payment attempt, then append a retry
    // suffix on subsequent attempts so ECPay accepts a fresh checkout for the same order.
    const merchantTradeNo = order.merchantTradeNo
      ? this.buildRetryMerchantTradeNo(order.orderNumber)
      : order.orderNumber;

    if (
      order.merchantTradeNo !== merchantTradeNo ||
      order.paymentProvider !== PaymentProvider.ECPAY ||
      order.paymentStatus !== PaymentStatus.UNPAID
    ) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          merchantTradeNo,
          paymentProvider: PaymentProvider.ECPAY,
          paymentStatus: PaymentStatus.UNPAID,
        },
      });
    }

    const fields: EcpayCheckoutFieldMap = {
      MerchantID: this.merchantId,
      MerchantTradeNo: merchantTradeNo,
      MerchantTradeDate: this.formatTradeDate(new Date()),
      PaymentType: 'aio',
      TotalAmount: `${order.totalAmount}`,
      TradeDesc: 'Goose order payment',
      ItemName: this.buildItemName(order.items.map((item) => item.itemName)),
      ReturnURL:
        this.configService.get<string>('ECPAY_RETURN_URL') ??
        `${this.backendBaseUrl}/payments/ecpay/notify`,
      OrderResultURL:
        this.configService.get<string>('ECPAY_ORDER_RESULT_URL') ??
        `${this.backendBaseUrl}/payments/ecpay/result`,
      ClientBackURL:
        this.configService.get<string>('ECPAY_CLIENT_BACK_URL') ??
        `${this.frontendBaseUrl}/orders`,
      ChoosePayment: 'Credit',
      EncryptType: '1',
      NeedExtraPaidInfo: 'Y',
      CustomField1: order.id,
      CustomField2: order.orderNumber,
    };

    fields.CheckMacValue = this.generateCheckMacValue(fields);

    this.logger.log(
      `ECPay checkout fields: ${JSON.stringify({
        MerchantID: fields.MerchantID,
        MerchantTradeNo: fields.MerchantTradeNo,
        ReturnURL: fields.ReturnURL,
        OrderResultURL: fields.OrderResultURL,
        ClientBackURL: fields.ClientBackURL,
        TotalAmount: fields.TotalAmount,
        ItemName: fields.ItemName,
      })}`,
    );

    return {
      action: this.checkoutAction,
      method: 'POST',
      fields,
    };
  }

  buildEcpayResultRedirectUrl(payload: Record<string, string>): string {
    this.logger.log(
      `ECPay order result received: ${JSON.stringify({
        MerchantTradeNo: payload.MerchantTradeNo,
        TradeNo: payload.TradeNo,
        RtnCode: payload.RtnCode,
        RtnMsg: payload.RtnMsg,
        PaymentType: payload.PaymentType,
      })}`,
    );

    const redirectUrl = new URL('/payment/ecpay/result', this.frontendBaseUrl);

    if (payload.CustomField1) {
      redirectUrl.searchParams.set('orderId', payload.CustomField1);
    }

    return redirectUrl.toString();
  }

  async simulateEcpayPaid(orderId: string): Promise<{
    message: string;
    orderId: string;
    orderNumber: string;
    status: OrderStatus;
  }> {
    if (
      this.configService.get<string>('ENABLE_PAYMENT_SIMULATION') !== 'true'
    ) {
      throw new ForbiddenException('模擬付款功能未啟用。');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        recipientName: true,
        totalAmount: true,
        paymentMethod: true,
        paymentStatus: true,
        notifications: {
          select: { id: true },
          take: 1,
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    if (order.paymentMethod !== PaymentMethod.online) {
      throw new BadRequestException('只有線上付款訂單才能模擬付款成功。');
    }

    if (order.paymentStatus !== PaymentStatus.PAID) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: PaymentStatus.PAID,
          status: OrderStatus.PENDING,
          tradeNo: `SIMULATED-${Date.now()}`,
          paidAt: new Date(),
          paymentProvider: PaymentProvider.ECPAY,
        },
      });
    }

    if (order.notifications.length === 0) {
      try {
        await this.notificationsService.createNewOrderNotification({
          orderId: order.id,
          orderNumber: order.orderNumber,
          recipientName: order.recipientName,
          totalAmount: order.totalAmount,
        });
      } catch (error) {
        this.logger.error(
          `Failed to create simulated paid-order notification for ${order.orderNumber}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    this.logger.log(`ECPay simulated paid for order ${order.orderNumber}`);

    return {
      message: '已模擬付款成功。',
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: OrderStatus.PENDING,
    };
  }

  async handleEcpayNotification(
    payload: Record<string, string>,
  ): Promise<string> {
    this.logger.log(
      `ECPay notify received: ${JSON.stringify({
        MerchantTradeNo: payload.MerchantTradeNo,
        TradeNo: payload.TradeNo,
        RtnCode: payload.RtnCode,
        RtnMsg: payload.RtnMsg,
        PaymentDate: payload.PaymentDate,
        SimulatePaid: payload.SimulatePaid,
      })}`,
    );

    const receivedCheckMacValue = payload.CheckMacValue;

    if (!receivedCheckMacValue) {
      this.logger.warn('Missing CheckMacValue in ECPay notification');
      throw new BadRequestException('Missing CheckMacValue');
    }

    const restPayload = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== 'CheckMacValue'),
    ) as Record<string, string>;
    const expectedCheckMacValue = this.generateCheckMacValue(restPayload);

    if (expectedCheckMacValue !== receivedCheckMacValue) {
      this.logger.warn('Invalid CheckMacValue from ECPay notification');
      throw new BadRequestException('Invalid CheckMacValue');
    }

    if (payload.MerchantID !== this.merchantId) {
      throw new BadRequestException('Invalid MerchantID');
    }

    const order = await this.resolveOrderForEcpayPayload(payload);

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    if (
      order.paymentMethod !== PaymentMethod.online ||
      payload.CustomField1 !== order.id ||
      payload.CustomField2 !== order.orderNumber ||
      payload.MerchantTradeNo !== order.merchantTradeNo ||
      Number(payload.TradeAmt) !== order.totalAmount
    ) {
      this.logger.warn(`ECPay notification order data mismatch: ${order.id}`);
      throw new BadRequestException('Payment data does not match order');
    }

    if (payload.RtnCode === '1') {
      await this.markOrderPaidFromEcpayPayload(payload);
    }

    return '1|OK';
  }

  async refundOrder(
    orderId: string,
    adminUserId: string | undefined,
    refundOrderDto: RefundOrderDto,
  ): Promise<{
    message: string;
    orderId: string;
    orderNumber: string;
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    refundedAmount: number;
  }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    if (order.paymentMethod !== PaymentMethod.online) {
      throw new BadRequestException('只有線上付款訂單才能刷退。');
    }

    if (
      order.paymentStatus !== PaymentStatus.PAID &&
      order.paymentStatus !== PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw new BadRequestException('這筆訂單目前不可刷退。');
    }

    if (
      order.status === OrderStatus.SHIPPED ||
      order.status === OrderStatus.COMPLETED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException('已出貨或已結案訂單不可刷退。');
    }

    if (!order.merchantTradeNo || !order.tradeNo) {
      throw new BadRequestException('缺少綠界交易資訊，無法進行刷退。');
    }

    // Build a normalized refund plan first so full and partial refunds share one validation path.
    const refundPlan = this.buildRefundPlan(order, refundOrderDto);

    if (refundPlan.amount <= 0) {
      throw new BadRequestException('退款金額需大於 0。');
    }

    const previousStatus = order.status;

    await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.REFUND_PROCESSING },
    });

    try {
      // Only persist refunded quantities and amounts after ECPay confirms the refund request.
      await this.issueEcpayRefund({
        merchantTradeNo: order.merchantTradeNo,
        tradeNo: order.tradeNo,
        amount: refundPlan.amount,
      });
        const nextRefundedAmount = order.refundedAmount + refundPlan.amount;
        const nextPaymentStatus =
          nextRefundedAmount >= order.totalAmount
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED;
        const nextOrderStatus =
          nextPaymentStatus === PaymentStatus.REFUNDED
            ? OrderStatus.REFUNDED
            // Older partial refunds could leave the order stuck as REFUNDED.
            // Normalize those legacy cases back to a payable state while a balance remains.
            : previousStatus === OrderStatus.REFUNDED ||
                previousStatus === OrderStatus.REFUND_PROCESSING
              ? OrderStatus.PAID
              : previousStatus;

      await this.prisma.$transaction(async (tx) => {
        for (const item of refundPlan.items) {
          await tx.orderItem.update({
            where: { id: item.orderItemId },
            data: {
              refundedQuantity: {
                increment: item.quantity,
              },
            },
          });
        }

        await tx.order.update({
          where: { id: order.id },
          data: {
            status: nextOrderStatus,
              paymentStatus: nextPaymentStatus,
            refundedAmount: nextRefundedAmount,
            refundReason: refundOrderDto.reason?.trim() || null,
            refundedAt: new Date(),
          },
        });
      });

      this.logger.log(
        'Refund succeeded for order ' +
          order.orderNumber +
          ' by ' +
          (adminUserId ?? 'unknown-admin') +
          ' amount ' +
          refundPlan.amount,
      );

      return {
        message:
          nextPaymentStatus === PaymentStatus.REFUNDED
            ? '已完成全額刷退。'
            : '已完成部分刷退。',
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: nextOrderStatus,
              paymentStatus: nextPaymentStatus,
        refundedAmount: nextRefundedAmount,
      };
    } catch (error) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: previousStatus },
      });

      throw error;
    }
  }
  private async resolveOrderForEcpayPayload(payload: Record<string, string>) {
    const orderId = payload.CustomField1;
    const orderNumber = payload.CustomField2;
    const merchantTradeNo = payload.MerchantTradeNo;

    if (orderId) {
      const byId = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          merchantTradeNo: true,
          recipientName: true,
          totalAmount: true,
          paymentMethod: true,
          paymentStatus: true,
          status: true,
          notifications: {
            select: { id: true },
            take: 1,
          },
        },
      });

      if (byId) {
        return byId;
      }
    }

    if (orderNumber) {
      const byOrderNumber = await this.prisma.order.findUnique({
        where: { orderNumber },
        select: {
          id: true,
          orderNumber: true,
          merchantTradeNo: true,
          recipientName: true,
          totalAmount: true,
          paymentMethod: true,
          paymentStatus: true,
          status: true,
          notifications: {
            select: { id: true },
            take: 1,
          },
        },
      });

      if (byOrderNumber) {
        return byOrderNumber;
      }
    }

    if (merchantTradeNo) {
      const byMerchantTradeNo = await this.prisma.order.findUnique({
        where: { merchantTradeNo },
        select: {
          id: true,
          orderNumber: true,
          merchantTradeNo: true,
          recipientName: true,
          totalAmount: true,
          paymentMethod: true,
          paymentStatus: true,
          status: true,
          notifications: {
            select: { id: true },
            take: 1,
          },
        },
      });

      if (byMerchantTradeNo) {
        return byMerchantTradeNo;
      }
    }

    return null;
  }

  private async markOrderPaidFromEcpayPayload(
    payload: Record<string, string>,
  ): Promise<void> {
    const order = await this.resolveOrderForEcpayPayload(payload);

    if (!order) {
      throw new NotFoundException('Order not found.');
    }

    const hasExistingNotification = order.notifications.length > 0;

    if (order.paymentStatus !== PaymentStatus.PAID) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: PaymentStatus.PAID,
          status: OrderStatus.PENDING,
          tradeNo: payload.TradeNo || null,
          paidAt: new Date(),
          paymentProvider: PaymentProvider.ECPAY,
        },
      });
    }

    if (!hasExistingNotification) {
      try {
        await this.notificationsService.createNewOrderNotification({
          orderId: order.id,
          orderNumber: order.orderNumber,
          recipientName: order.recipientName,
          totalAmount: order.totalAmount,
        });
      } catch (error) {
        this.logger.error(
          'Failed to create paid-order notification for ' + order.orderNumber,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  private async cancelExpiredUnpaidOrders(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.unpaidOrderTimeoutInMs);

      const result = await this.prisma.order.updateMany({
        where: {
          paymentMethod: PaymentMethod.online,
          paymentStatus: {
            in: [PaymentStatus.UNPAID, PaymentStatus.FAILED],
          },
          status: {
            not: OrderStatus.CANCELLED,
          },
          updatedAt: {
            lte: cutoff,
          },
        },
        data: {
          paymentStatus: PaymentStatus.FAILED,
          status: OrderStatus.CANCELLED,
        },
      });

      if (result.count > 0) {
        this.logger.log(
          `Cancelled ${result.count} expired unpaid online order(s) after ${this.unpaidOrderTimeoutInMs / 60000} minutes.`,
        );
      }
    } catch (error) {
      this.logger.warn(
        'Failed to sweep expired unpaid online orders.',
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  private buildRefundPlan(
    order: {
      totalAmount: number;
      refundedAmount: number;
      shippingFee: number;
      items: Array<{
        id: string;
        unitPrice: number;
        quantity: number;
        refundedQuantity: number;
      }>;
    },
    refundOrderDto: RefundOrderDto,
  ) {
    if (refundOrderDto.mode === RefundRequestMode.FULL) {
      return {
        amount: order.totalAmount - order.refundedAmount,
        items: order.items
          .map((item) => ({
            orderItemId: item.id,
            quantity: Math.max(item.quantity - item.refundedQuantity, 0),
          }))
          .filter((item) => item.quantity > 0),
      };
    }

    const items = (refundOrderDto.items ?? []).map((requestedItem) => {
      const target = order.items.find((item) => item.id === requestedItem.orderItemId);

      if (!target) {
        throw new BadRequestException('退款品項不存在。');
      }

      const remainingQuantity = target.quantity - target.refundedQuantity;

      if (requestedItem.quantity > remainingQuantity) {
        throw new BadRequestException('退款數量超過可退範圍。');
      }

      return {
        orderItemId: target.id,
        quantity: requestedItem.quantity,
        amount: target.unitPrice * requestedItem.quantity,
      };
    });

    const refundedItemsAmount = order.items.reduce(
      (sum, item) => sum + item.refundedQuantity * item.unitPrice,
      0,
    );
    const refundedShippingFee = Math.max(order.refundedAmount - refundedItemsAmount, 0);
    const remainingShippingFee = Math.max(order.shippingFee - refundedShippingFee, 0);
    const includeShippingFee = Boolean(
      refundOrderDto.refundShippingFee && remainingShippingFee > 0,
    );

    return {
      amount:
        items.reduce((sum, item) => sum + item.amount, 0) +
        (includeShippingFee ? remainingShippingFee : 0),
      items: items.map(({ orderItemId, quantity }) => ({ orderItemId, quantity })),
    };
  }
  private async issueEcpayRefund(params: {
    merchantTradeNo: string;
    tradeNo: string;
    amount: number;
  }): Promise<Record<string, string>> {
    const fields: EcpayCheckoutFieldMap = {
      MerchantID: this.merchantId,
      MerchantTradeNo: params.merchantTradeNo,
      TradeNo: params.tradeNo,
      Action: 'R',
      TotalAmount: String(params.amount),
    };

    fields.CheckMacValue = this.generateCheckMacValue(fields);

    const response = await fetch(this.refundAction, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: new URLSearchParams(fields).toString(),
    });

    const rawText = await response.text();
    const parsed = Object.fromEntries(new URLSearchParams(rawText));

    if (!response.ok) {
      throw new InternalServerErrorException('綠界退款請求失敗。');
    }

    const rtnCode = parsed.RtnCode ?? parsed.rtnCode;
    if (rtnCode !== '1') {
      throw new BadRequestException(parsed.RtnMsg || parsed.rtnMsg || '綠界刷退失敗。');
    }

    return parsed;
  }
  private buildItemName(itemNames: string[]): string {
    const fallback = '鵝作社訂單';
    const joined = itemNames.filter(Boolean).join('#').trim();

    if (!joined) {
      return fallback;
    }

    return joined.length > 200 ? `${joined.slice(0, 197)}...` : joined;
  }

  private formatTradeDate(value: Date): string {
    const year = value.getFullYear();
    const month = `${value.getMonth() + 1}`.padStart(2, '0');
    const date = `${value.getDate()}`.padStart(2, '0');
    const hours = `${value.getHours()}`.padStart(2, '0');
    const minutes = `${value.getMinutes()}`.padStart(2, '0');
    const seconds = `${value.getSeconds()}`.padStart(2, '0');

    return `${year}/${month}/${date} ${hours}:${minutes}:${seconds}`;
  }

  private buildRetryMerchantTradeNo(orderNumber: string): string {
    const retrySuffix = `${Date.now()}`.slice(-5);
    return `${orderNumber}${retrySuffix}`.slice(0, 20);
  }

  private generateCheckMacValue(fields: Record<string, string>): string {
    const sortedEntries = Object.entries(fields)
      .filter((entry) => entry[0] !== 'CheckMacValue')
      .map(([key, value]) => [key, value ?? ''] as const)
      .sort((left, right) => (left[0] > right[0] ? 1 : -1));

    const queryString = sortedEntries
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('&');

    const raw = `HashKey=${this.hashKey}&${queryString}&HashIV=${this.hashIv}`;
    const encoded = this.toEcpayEncodedValue(raw);

    return createHash('sha256').update(encoded).digest('hex').toUpperCase();
  }

  private toEcpayEncodedValue(value: string): string {
    return encodeURIComponent(value)
      .toLowerCase()
      .replace(/%20/g, '+')
      .replace(/%2d/g, '-')
      .replace(/%5f/g, '_')
      .replace(/%2e/g, '.')
      .replace(/%21/g, '!')
      .replace(/%2a/g, '*')
      .replace(/%28/g, '(')
      .replace(/%29/g, ')');
  }
}










