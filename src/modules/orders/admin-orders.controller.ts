import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PaymentsService } from '../payments/payments.service';
import { RefundOrderDto } from './dto/refund-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import {
  OrdersService,
  type AdminProductStatsPreset,
  type AdminProductStatsResponse,
  type OrderHistoryResponse,
  type RefundOrderResponse,
  type UpdateOrderStatusResponse,
} from './orders.service';

@UseGuards(AdminGuard)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Get()
  getAdminOrders(): Promise<OrderHistoryResponse> {
    return this.ordersService.getAdminOrders();
  }

  @Get('product-stats')
  getAdminProductStats(
    @Query('preset') preset?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<AdminProductStatsResponse> {
    return this.ordersService.getAdminProductStats({
      preset: (preset as AdminProductStatsPreset | undefined) ?? 'today',
      startDate,
      endDate,
    });
  }

  @Patch(':orderId/status')
  updateOrderStatus(
    @Param('orderId') orderId: string,
    @Body() updateOrderStatusDto: UpdateOrderStatusDto,
  ): Promise<UpdateOrderStatusResponse> {
    return this.ordersService.updateOrderStatus(
      orderId,
      updateOrderStatusDto.status,
    );
  }

  @Post(':orderId/refund')
  refundOrder(
    @Param('orderId') orderId: string,
    @Body() refundOrderDto: RefundOrderDto,
    @Req() request: Request & { user?: { sub?: string } },
  ): Promise<RefundOrderResponse> {
    return this.paymentsService.refundOrder(
      orderId,
      request.user?.sub,
      refundOrderDto,
    );
  }
}

