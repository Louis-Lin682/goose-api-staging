import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../../modules/auth/auth.service';

const AUTH_COOKIE_NAME = 'goose_admin_session';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const sessionToken = this.getCookieValue(
      request.headers.cookie,
      AUTH_COOKIE_NAME,
    );

    if (!sessionToken) {
      throw new UnauthorizedException('請先登入管理員帳號。');
    }

    const user = await this.authService.getAuthenticatedUser(sessionToken);

    if (!user.isAdmin) {
      throw new ForbiddenException('只有管理員可以存取後台。');
    }

    return true;
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
