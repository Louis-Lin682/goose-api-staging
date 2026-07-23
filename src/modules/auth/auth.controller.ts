import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import {
  AuthService,
  type AuthUser,
  type ForgotPasswordResponse,
  type LoginResponse,
  type RegisterResponse,
  type ResetPasswordResponse,
} from './auth.service';

const AUTH_COOKIE_NAME = 'goose_session';
const ADMIN_AUTH_COOKIE_NAME = 'goose_admin_session';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() registerDto: RegisterDto): Promise<RegisterResponse> {
    return this.authService.register(registerDto);
  }

  @Post('login')
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const result = await this.authService.login(loginDto);
    const sessionToken = this.authService.createSessionToken(
      result.user.id,
      result.user.isAdmin,
    );

    response.cookie(
      AUTH_COOKIE_NAME,
      sessionToken,
      this.authService.getCookieOptions(result.user.isAdmin),
    );

    return result;
  }

  @Post('admin/login')
  async adminLogin(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const result = await this.authService.login(loginDto);

    if (!result.user.isAdmin) {
      throw new UnauthorizedException('此帳號沒有後台管理權限。');
    }

    const sessionToken = this.authService.createSessionToken(
      result.user.id,
      true,
    );
    response.cookie(
      ADMIN_AUTH_COOKIE_NAME,
      sessionToken,
      this.authService.getCookieOptions(true),
    );

    return result;
  }

  @Get('line/start')
  lineStart(
    @Query('mode') mode: 'login' | 'register' | undefined,
    @Res() response: Response,
  ): void {
    const lineMode = mode === 'register' ? 'register' : 'login';
    const { authorizationUrl } =
      this.authService.createLineAuthorizationUrl(lineMode);
    response.redirect(authorizationUrl);
  }

  @Get('line/callback')
  async lineCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const result = await this.authService.handleLineCallback({ code, state });
      const sessionToken = this.authService.createSessionToken(
        result.user.id,
        result.user.isAdmin,
      );

      response.cookie(
        AUTH_COOKIE_NAME,
        sessionToken,
        this.authService.getCookieOptions(result.user.isAdmin),
      );
      response.redirect(result.redirectUrl);
    } catch (error) {
      response.redirect(this.authService.getLineFailureRedirectUrl(error));
    }
  }

  @Post('forgot-password')
  forgotPassword(
    @Body() forgotPasswordDto: ForgotPasswordDto,
  ): Promise<ForgotPasswordResponse> {
    return this.authService.forgotPassword(forgotPasswordDto);
  }

  @Post('reset-password')
  resetPassword(
    @Body() resetPasswordDto: ResetPasswordDto,
  ): Promise<ResetPasswordResponse> {
    return this.authService.resetPassword(resetPasswordDto);
  }

  @Get('me')
  async me(
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: AuthUser | null }> {
    const sessionToken = this.getCookieValue(cookieHeader, AUTH_COOKIE_NAME);

    if (!sessionToken) {
      return { user: null };
    }

    const user = await this.authService.getAuthenticatedUser(sessionToken);
    this.authService.renewSession(response, user.id, user.isAdmin);

    return { user };
  }

  @Get('admin/me')
  async adminMe(
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: AuthUser | null }> {
    const sessionToken = this.getCookieValue(
      cookieHeader,
      ADMIN_AUTH_COOKIE_NAME,
    );

    if (!sessionToken) {
      return { user: null };
    }

    const user = await this.authService.getAuthenticatedUser(sessionToken);

    if (!user.isAdmin) {
      return { user: null };
    }

    this.authService.renewSession(
      response,
      user.id,
      true,
      ADMIN_AUTH_COOKIE_NAME,
    );
    return { user };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response): { message: string } {
    response.clearCookie(
      AUTH_COOKIE_NAME,
      this.authService.getClearCookieOptions(),
    );

    return {
      message: 'Logout success',
    };
  }

  @Post('admin/logout')
  adminLogout(
    @Res({ passthrough: true }) response: Response,
  ): { message: string } {
    response.clearCookie(
      ADMIN_AUTH_COOKIE_NAME,
      this.authService.getClearCookieOptions(),
    );

    return { message: 'Logout success' };
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
