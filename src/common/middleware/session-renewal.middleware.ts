import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuthService } from '../../modules/auth/auth.service';

const AUTH_COOKIE_NAME = 'goose_session';

@Injectable()
export class SessionRenewalMiddleware implements NestMiddleware {
  constructor(private readonly authService: AuthService) {}

  async use(
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    const sessionToken = this.getCookieValue(
      request.headers.cookie,
      AUTH_COOKIE_NAME,
    );

    if (!sessionToken) {
      next();
      return;
    }

    try {
      const user = await this.authService.getAuthenticatedUser(sessionToken);
      this.authService.renewSession(response, user.id, user.isAdmin);
    } catch {
      // Ignore invalid or expired sessions here; the downstream route will enforce auth if needed.
    }

    next();
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
