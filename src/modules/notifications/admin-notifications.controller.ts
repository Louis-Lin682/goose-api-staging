import {
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AuthService, type AuthUser } from '../auth/auth.service';
import {
  NotificationsService,
  type AdminNotificationsResponse,
  type MarkAllNotificationsReadResponse,
  type MarkNotificationReadResponse,
} from './notifications.service';

const AUTH_COOKIE_NAME = 'goose_session';

@UseGuards(AdminGuard)
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async getAdminNotifications(
    @Headers('cookie') cookieHeader?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<AdminNotificationsResponse> {
    const user = await this.getAuthenticatedUser(cookieHeader);
    if (response) {
      this.authService.renewSession(response, user.id, user.isAdmin);
    }
    return this.notificationsService.getAdminNotifications(user.id);
  }

  @Patch('read-all')
  async markAllAsRead(
    @Headers('cookie') cookieHeader?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<MarkAllNotificationsReadResponse> {
    const user = await this.getAuthenticatedUser(cookieHeader);
    if (response) {
      this.authService.renewSession(response, user.id, user.isAdmin);
    }
    return this.notificationsService.markAllAsRead(user.id);
  }

  @Patch(':notificationId/read')
  async markAsRead(
    @Param('notificationId') notificationId: string,
    @Headers('cookie') cookieHeader?: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<MarkNotificationReadResponse> {
    const user = await this.getAuthenticatedUser(cookieHeader);
    if (response) {
      this.authService.renewSession(response, user.id, user.isAdmin);
    }
    return this.notificationsService.markAsRead(user.id, notificationId);
  }

  private async getAuthenticatedUser(cookieHeader?: string): Promise<AuthUser> {
    const sessionToken = this.getCookieValue(cookieHeader, AUTH_COOKIE_NAME);

    if (!sessionToken) {
      throw new UnauthorizedException('Admin session not found');
    }

    return this.authService.getAuthenticatedUser(sessionToken);
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
