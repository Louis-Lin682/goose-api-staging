import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Header,
  Logger,
  Post,
  Query,
  Req,
  Res,
  Body,
  UseGuards,
} from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import type { Request, Response } from 'express';
import { AuthService, type AuthUser } from '../auth/auth.service';
import { CreateEcpayCheckoutDto } from './dto/create-ecpay-checkout.dto';
import { AdminGuard } from '../../common/guards/admin.guard';
import {
  PaymentsService,
  type EcpayCheckoutResponse,
} from './payments.service';

const AUTH_COOKIE_NAME = 'goose_session';

@Controller('payments/ecpay')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly authService: AuthService,
  ) {}

  @Post('checkout')
  async createCheckout(
    @Body() createCheckoutDto: CreateEcpayCheckoutDto,
    @Headers('cookie') cookieHeader?: string,
  ): Promise<EcpayCheckoutResponse> {
    const user = await this.getAuthenticatedUser(cookieHeader);

    return this.paymentsService.createEcpayCheckout(
      createCheckoutDto.orderId,
      user?.id,
    );
  }

  @Post('dev-simulate-paid')
  @UseGuards(AdminGuard)
  async handleDevSimulatePaid(@Body() payload: { orderId: string }): Promise<{
    message: string;
    orderId: string;
    orderNumber: string;
    status: OrderStatus;
  }> {
    if (!payload.orderId) {
      throw new BadRequestException('Missing orderId');
    }

    return this.paymentsService.simulateEcpayPaid(payload.orderId);
  }

  @Post('notify')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async handleNotify(
    @Body() payload: Record<string, string>,
    @Headers('content-type') contentType?: string,
  ): Promise<string> {
    this.logger.log(
      `ECPay notify controller payload: ${JSON.stringify({
        contentType,
        keys: Object.keys(payload ?? {}),
        payload,
      })}`,
    );

    return this.paymentsService.handleEcpayNotification(payload);
  }

  @Post('result')
  async handleResult(
    @Req() request: Request,
    @Body() payload: Record<string, string>,
    @Headers('content-type') contentType: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    this.logger.log(
      `ECPay result controller payload: ${JSON.stringify({
        method: request.method,
        contentType,
        keys: Object.keys(payload ?? {}),
        payload,
        query: request.query,
      })}`,
    );

    const redirectUrl =
      await this.paymentsService.buildEcpayResultRedirectUrl(payload);
    response.redirect(302, redirectUrl);
  }

  @Get('result')
  async handleResultFallback(
    @Query() payload: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    this.logger.log(
      `ECPay result fallback payload: ${JSON.stringify({
        keys: Object.keys(payload ?? {}),
        payload,
      })}`,
    );

    const redirectUrl =
      await this.paymentsService.buildEcpayResultRedirectUrl(payload);
    response.redirect(302, redirectUrl);
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
