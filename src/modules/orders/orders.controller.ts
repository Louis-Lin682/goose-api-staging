import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService, type AuthUser } from '../auth/auth.service';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  OrdersService,
  type CreateOrderResponse,
  type OrderHistoryResponse,
} from './orders.service';

const AUTH_COOKIE_NAME = 'goose_session';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly authService: AuthService,
  ) {}

  @Post()
  async createOrder(
    @Body() createOrderDto: CreateOrderDto,
    @Headers('cookie') cookieHeader?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<CreateOrderResponse> {
    const user = await this.getAuthenticatedUser(cookieHeader);

    if (!user) {
      throw new UnauthorizedException('Please log in before checking out.');
    }

    if (response) {
      this.authService.renewSession(response, user.id, user.isAdmin);
    }

    return this.ordersService.createOrder(createOrderDto, user.id);
  }

  @Get()
  async getOrderHistory(
    @Headers('cookie') cookieHeader?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<OrderHistoryResponse> {
    const user = await this.getAuthenticatedUser(cookieHeader);

    if (user && response) {
      this.authService.renewSession(response, user.id, user.isAdmin);
    }

    return this.ordersService.getOrderHistory(user?.id);
  }

  private async getAuthenticatedUser(
    cookieHeader?: string,
  ): Promise<AuthUser | null> {
    const sessionToken = this.getCookieValue(cookieHeader, AUTH_COOKIE_NAME);

    if (!sessionToken) {
      return null;
    }

    try {
      return await this.authService.getAuthenticatedUser(sessionToken);
    } catch {
      return null;
    }
  }

  private getCookieValue(
    cookieHeader: string | undefined,
    key: string,
  ): string | null {
    if (!cookieHeader) {
      return null;
    }

    const pairs = cookieHeader.split(';');

    for (const pair of pairs) {
      const [name, ...rawValue] = pair.trim().split('=');

      if (name === key) {
        return rawValue.join('=');
      }
    }

    return null;
  }
}
