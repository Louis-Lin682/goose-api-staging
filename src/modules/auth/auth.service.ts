import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import * as argon2 from 'argon2';
import type { CookieOptions, Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

// Storefront sessions stay longer to survive browsing and payment flows; admin sessions
// stay shorter because the backend console is more sensitive.
const ADMIN_SESSION_TIMEOUT_IN_MS = 30 * 60 * 1000;
const CUSTOMER_SESSION_TIMEOUT_IN_MS = 12 * 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_TTL_IN_MS = 30 * 60 * 1000;
const LINE_STATE_TIMEOUT_IN_MS = 10 * 60 * 1000;
const LINE_AUTH_BASE_URL = 'https://access.line.me/oauth2/v2.1/authorize';
const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';
const LINE_VERIFY_ID_TOKEN_URL = 'https://api.line.me/oauth2/v2.1/verify';

type SessionPayload = {
  sub: string;
  exp: number;
};

type LineStatePayload = {
  nonce: string;
  mode: 'login' | 'register';
  exp: number;
};

type AuthUserRecord = {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string | null;
  role: UserRole;
  lineUserId?: string | null;
  linePictureUrl?: string | null;
};

type LineCallbackArgs = {
  code: string | undefined;
  state: string | undefined;
};

type LineTokenResponse = {
  access_token: string;
  id_token: string;
};

type LineVerifiedProfile = {
  sub: string;
  name?: string;
  picture?: string;
  email?: string;
};

export type AuthUser = {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string | null;
  role: UserRole;
  isAdmin: boolean;
};

export type RegisterResponse = {
  message: string;
};

export type LoginResponse = {
  message: string;
  user: AuthUser;
};

export type ForgotPasswordResponse = {
  message: string;
  resetToken?: string;
  resetLink?: string;
  expiresAt?: string;
};

export type ResetPasswordResponse = {
  message: string;
};

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async register(registerDto: RegisterDto): Promise<RegisterResponse> {
    const name = registerDto.name.trim();
    const phone = registerDto.phone.trim();
    const email = registerDto.email.trim().toLowerCase();

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ phone }, { email }],
      },
    });

    if (existingUser?.phone === phone) {
      throw new ConflictException('Phone number is already registered.');
    }

    if (existingUser?.email === email) {
      throw new ConflictException('Email is already registered.');
    }

    const passwordHash = await argon2.hash(registerDto.password);

    await this.prisma.user.create({
      data: {
        name,
        phone,
        email,
        passwordHash,
        role: this.resolveBootstrapRole({ email, phone }),
      },
    });

    return {
      message: 'Register success',
    };
  }

  async login(loginDto: LoginDto): Promise<LoginResponse> {
    const identifier = loginDto.identifier.trim();
    const normalizedEmail = identifier.toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ phone: identifier }, { email: normalizedEmail }],
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        address: true,
        passwordHash: true,
        role: true,
        lineUserId: true,
        linePictureUrl: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('?????Email ?????');
    }

    const isPasswordValid = await argon2.verify(
      user.passwordHash,
      loginDto.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('?????Email ?????');
    }

    const syncedUser = await this.syncBootstrapAdminRole({
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      address: user.address,
      role: user.role,
      lineUserId: user.lineUserId,
      linePictureUrl: user.linePictureUrl,
    });

    return {
      message: 'Login success',
      user: this.toAuthUser(syncedUser),
    };
  }

  createLineAuthorizationUrl(mode: 'login' | 'register'): {
    authorizationUrl: string;
  } {
    // Use a signed state token so the callback cannot be forged or replayed out of context.
    const nonce = randomBytes(16).toString('hex');
    const callbackUrl = this.getLineLoginRedirectUri();
    const channelId = this.getRequiredLineConfig('LINE_LOGIN_CHANNEL_ID');
    const signedState = this.createSignedStateToken({
      nonce,
      mode,
      exp: Date.now() + LINE_STATE_TIMEOUT_IN_MS,
    });

    const url = new URL(LINE_AUTH_BASE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', channelId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('state', signedState);
    url.searchParams.set('scope', 'openid profile');
    url.searchParams.set('bot_prompt', 'aggressive');
    url.searchParams.set('nonce', nonce);

    return {
      authorizationUrl: url.toString(),
    };
  }

  async handleLineCallback(
    args: LineCallbackArgs,
  ): Promise<{ user: AuthUser; redirectUrl: string }> {
    if (!args.code || !args.state) {
      throw new BadRequestException(
        'LINE login callback is missing required parameters.',
      );
    }

    const storedState = this.verifySignedStateToken(args.state);

    const tokenResponse = await this.exchangeLineCodeForToken(args.code);
    const verifiedProfile = await this.verifyLineIdToken(
      tokenResponse.id_token,
      storedState.nonce,
    );
    let user: AuthUserRecord;

    try {
      user = await this.findOrCreateLineUser(verifiedProfile);
    } catch (error) {
      if (this.getPrismaErrorCode(error) !== 'ETIMEDOUT') {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
      user = await this.findOrCreateLineUser(verifiedProfile);
    }

    return {
      user: this.toAuthUser(user),
      redirectUrl: this.getLineSuccessRedirectUrl(user.role === UserRole.ADMIN),
    };
  }

  async forgotPassword(
    forgotPasswordDto: ForgotPasswordDto,
  ): Promise<ForgotPasswordResponse> {
    const email = forgotPasswordDto.identifier.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });

    if (!user) {
      return {
        message: '?? Email ????????????????',
      };
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_IN_MS);

    // Keep only the newest reset token usable for this member.
    await this.prisma.passwordResetToken.deleteMany({
      where: {
        OR: [{ userId: user.id }, { expiresAt: { lt: new Date() } }],
      },
    });

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    const frontendAppUrl = (
      process.env.FRONTEND_APP_URL ?? 'http://localhost:5173'
    ).replace(/\/$/, '');
    const resetLink = `${frontendAppUrl}/forgot-password?token=${rawToken}`;

    const response: ForgotPasswordResponse = {
      message: '?? Email ????????????????',
    };

    if (this.shouldExposeResetToken()) {
      response.resetToken = rawToken;
      response.resetLink = resetLink;
      response.expiresAt = expiresAt.toISOString();
    }

    if (this.hasEmailDeliveryConfig()) {
      await this.sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetLink,
        expiresAt,
      });
    } else if (!this.shouldExposeResetToken()) {
      throw new InternalServerErrorException('Email ???????????');
    }

    return response;
  }
  async resetPassword(
    resetPasswordDto: ResetPasswordDto,
  ): Promise<ResetPasswordResponse> {
    const tokenHash = this.hashResetToken(resetPasswordDto.token.trim());

    const resetToken = await this.prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      select: {
        id: true,
        userId: true,
      },
    });

    if (!resetToken) {
      throw new UnauthorizedException('???????????');
    }

    const passwordHash = await argon2.hash(resetPasswordDto.password);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: resetToken.userId },
        data: { passwordHash },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.passwordResetToken.deleteMany({
        where: {
          userId: resetToken.userId,
          usedAt: null,
          id: { not: resetToken.id },
        },
      }),
    ]);

    return {
      message: '????????',
    };
  }

  async getAuthenticatedUser(sessionToken: string): Promise<AuthUser> {
    const payload = this.verifySessionToken(sessionToken);

    const findUser = async (): Promise<AuthUserRecord | null> =>
      this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          address: true,
          role: true,
          lineUserId: true,
          linePictureUrl: true,
        },
      });

    let user: Awaited<ReturnType<typeof findUser>> | null = null;

    try {
      user = await findUser();
    } catch (error) {
      const errorCode = this.getPrismaErrorCode(error);

      if (errorCode !== 'ETIMEDOUT') {
        throw error;
      }

      // Retry once so a transient DB wake-up does not immediately log the user out.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      user = await findUser();
    }

    if (!user) {
      throw new UnauthorizedException('Session is invalid or has expired.');
    }

    const syncedUser = await this.syncBootstrapAdminRole(user);
    return this.toAuthUser(syncedUser);
  }

  // Admin and storefront share one cookie name, but the expiry is role-based.
  createSessionToken(userId: string, isAdmin: boolean): string {
    const expiresAt = Date.now() + this.getSessionTimeoutInMs(isAdmin);
    const payload = Buffer.from(
      JSON.stringify({
        sub: userId,
        exp: expiresAt,
      } satisfies SessionPayload),
      'utf8',
    ).toString('base64url');
    const signature = this.signPayload(payload);

    return `${payload}.${signature}`;
  }

  getCookieOptions(isAdmin: boolean): CookieOptions {
    return {
      ...this.getCookieBaseOptions(),
      maxAge: this.getSessionTimeoutInMs(isAdmin),
    };
  }

  renewSession(
    response: Response,
    userId: string,
    isAdmin: boolean,
    cookieName = 'goose_session',
  ): void {
    const sessionToken = this.createSessionToken(userId, isAdmin);
    response.cookie(
      cookieName,
      sessionToken,
      this.getCookieOptions(isAdmin),
    );
  }

  getClearCookieOptions(): CookieOptions {
    return this.getCookieBaseOptions();
  }

  getLineFailureRedirectUrl(error: unknown): string {
    const frontendAppUrl = (
      process.env.FRONTEND_APP_URL ?? 'http://localhost:5173'
    ).replace(/\/$/, '');
    const message =
      error instanceof Error ? error.message : 'LINE login failed.';

    return `${frontendAppUrl}/auth/line/complete?status=error&message=${encodeURIComponent(message)}`;
  }

  private getCookieBaseOptions(): CookieOptions {
    const secure = process.env.NODE_ENV === 'production';

    return {
      httpOnly: true,
      sameSite: secure ? 'none' : 'lax',
      secure,
      path: '/',
    };
  }

  private getSessionTimeoutInMs(isAdmin: boolean): number {
    return isAdmin
      ? ADMIN_SESSION_TIMEOUT_IN_MS
      : CUSTOMER_SESSION_TIMEOUT_IN_MS;
  }

  private verifySessionToken(sessionToken: string): SessionPayload {
    const [payloadPart, signaturePart] = sessionToken.split('.');

    if (!payloadPart || !signaturePart) {
      throw new UnauthorizedException('Session is invalid or has expired.');
    }

    const expectedSignature = this.signPayload(payloadPart);
    const providedSignature = Buffer.from(signaturePart, 'utf8');
    const safeExpectedSignature = Buffer.from(expectedSignature, 'utf8');

    if (
      providedSignature.length !== safeExpectedSignature.length ||
      !timingSafeEqual(providedSignature, safeExpectedSignature)
    ) {
      throw new UnauthorizedException('Session is invalid or has expired.');
    }

    const decoded = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const payload = this.parseSessionPayload(decoded);

    if (!payload.sub || !payload.exp || payload.exp < Date.now()) {
      throw new UnauthorizedException('Session is invalid or has expired.');
    }

    return payload;
  }

  private parseSessionPayload(value: string): SessionPayload {
    let parsed: unknown;

    try {
      parsed = JSON.parse(value);
    } catch {
      throw new UnauthorizedException('Session is invalid or has expired.');
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('sub' in parsed) ||
      !('exp' in parsed) ||
      typeof parsed.sub !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      throw new UnauthorizedException('Session is invalid or has expired.');
    }

    return {
      sub: parsed.sub,
      exp: parsed.exp,
    };
  }

  private createSignedStateToken(payload: LineStatePayload): string {
    const rawPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
      'base64url',
    );
    const signature = this.signPayload(rawPayload);

    return `${rawPayload}.${signature}`;
  }

  private verifySignedStateToken(token: string | null): LineStatePayload {
    if (!token) {
      throw new UnauthorizedException('LINE login session has expired.');
    }

    const [payloadPart, signaturePart] = token.split('.');

    if (!payloadPart || !signaturePart) {
      throw new UnauthorizedException('LINE login session is invalid.');
    }

    const expectedSignature = this.signPayload(payloadPart);
    const providedSignature = Buffer.from(signaturePart, 'utf8');
    const safeExpectedSignature = Buffer.from(expectedSignature, 'utf8');

    if (
      providedSignature.length !== safeExpectedSignature.length ||
      !timingSafeEqual(providedSignature, safeExpectedSignature)
    ) {
      throw new UnauthorizedException('LINE login session is invalid.');
    }

    const parsed = JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8'),
    ) as LineStatePayload;

    if (!parsed.nonce || !parsed.mode || parsed.exp < Date.now()) {
      throw new UnauthorizedException('LINE login session has expired.');
    }

    return parsed;
  }

  private signPayload(payload: string): string {
    const secret =
      process.env.AUTH_SECRET ??
      (process.env.NODE_ENV === 'production'
        ? undefined
        : 'dev-only-change-me');

    if (!secret) {
      throw new InternalServerErrorException('AUTH_SECRET is missing.');
    }

    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  private hashResetToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private hasEmailDeliveryConfig(): boolean {
    return Boolean(
      process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim(),
    );
  }

  private async sendPasswordResetEmail(args: {
    to: string;
    name: string;
    resetLink: string;
    expiresAt: Date;
  }): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.EMAIL_FROM?.trim();

    if (!apiKey || !from) {
      throw new InternalServerErrorException('Email ???????????');
    }

    const replyTo = process.env.EMAIL_REPLY_TO?.trim();
    const expiryLabel = args.expiresAt.toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const html = `
      <div style="font-family: Arial, 'Noto Sans TC', sans-serif; line-height: 1.7; color: #18181b;">
        <h2 style="margin-bottom: 16px;">Hi ${args.name}????????? - ?????????</h2>
        <p>???????????????????????</p>
        <p style="margin: 24px 0;">
          <a href="${args.resetLink}" style="display:inline-block;padding:12px 20px;border-radius:16px;background:#18181b;color:#ffffff;text-decoration:none;font-weight:700;">????</a>
        </p>
        <p>?????? <strong>${expiryLabel}</strong> ????</p>
        <p>??????????????????????</p>
      </div>
    `;

    const payload: Record<string, unknown> = {
      from,
      to: [args.to],
      subject: '??? - ??????? ??????',
      html,
      text: `Hi ${args.name}??????????????? - ??????? ???${args.resetLink}?????? ${expiryLabel} ????`,
    };

    if (replyTo) {
      payload.reply_to = replyTo;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new InternalServerErrorException('??????????????');
    }
  }
  private shouldExposeResetToken(): boolean {
    return (
      process.env.NODE_ENV === 'development' &&
      process.env.PASSWORD_RESET_DEBUG === 'true'
    );
  }

  private getRequiredLineConfig(
    key: 'LINE_LOGIN_CHANNEL_ID' | 'LINE_LOGIN_CHANNEL_SECRET',
  ): string {
    const value = process.env[key]?.trim();

    if (!value) {
      throw new InternalServerErrorException(`${key} is missing.`);
    }

    return value;
  }

  private getLineLoginRedirectUri(): string {
    const explicitRedirectUri = process.env.LINE_LOGIN_REDIRECT_URI?.trim();

    if (explicitRedirectUri) {
      return explicitRedirectUri;
    }

    if (process.env.NODE_ENV === 'production') {
      const frontendAppUrl = process.env.FRONTEND_APP_URL?.trim();

      if (!frontendAppUrl) {
        throw new InternalServerErrorException('FRONTEND_APP_URL is missing.');
      }

      return `${frontendAppUrl.replace(/\/$/, '')}/api/auth/line/callback`;
    }

    const backendBaseUrl = (
      process.env.BACKEND_BASE_URL ?? 'http://localhost:3001'
    ).trim();
    return `${backendBaseUrl.replace(/\/$/, '')}/auth/line/callback`;
  }

  private getLineSuccessRedirectUrl(isAdmin: boolean): string {
    const frontendAppUrl = (
      process.env.FRONTEND_APP_URL ?? 'http://localhost:5173'
    ).replace(/\/$/, '');
    const next = isAdmin ? '/admin/notifications' : '/';

    return `${frontendAppUrl}/auth/line/complete?next=${encodeURIComponent(next)}`;
  }

  private async exchangeLineCodeForToken(
    code: string,
  ): Promise<LineTokenResponse> {
    const response = await fetch(LINE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.getLineLoginRedirectUri(),
        client_id: this.getRequiredLineConfig('LINE_LOGIN_CHANNEL_ID'),
        client_secret: this.getRequiredLineConfig('LINE_LOGIN_CHANNEL_SECRET'),
      }),
    });

    if (!response.ok) {
      throw new UnauthorizedException(
        'Failed to exchange LINE authorization code.',
      );
    }

    const data = (await response.json()) as Partial<LineTokenResponse>;

    if (!data.access_token || !data.id_token) {
      throw new UnauthorizedException('LINE token response is incomplete.');
    }

    return {
      access_token: data.access_token,
      id_token: data.id_token,
    };
  }

  private async verifyLineIdToken(
    idToken: string,
    nonce: string,
  ): Promise<LineVerifiedProfile> {
    const response = await fetch(LINE_VERIFY_ID_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        id_token: idToken,
        client_id: this.getRequiredLineConfig('LINE_LOGIN_CHANNEL_ID'),
        nonce,
      }),
    });

    if (!response.ok) {
      throw new UnauthorizedException('Failed to verify LINE ID token.');
    }

    const data = (await response.json()) as LineVerifiedProfile;

    if (!data.sub) {
      throw new UnauthorizedException(
        'LINE ID token is missing the user identifier.',
      );
    }

    return data;
  }

  private async findOrCreateLineUser(
    profile: LineVerifiedProfile,
  ): Promise<AuthUserRecord> {
    const existingLineUser = await this.prisma.user.findFirst({
      where: {
        lineUserId: profile.sub,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        address: true,
        role: true,
        lineUserId: true,
        linePictureUrl: true,
      },
    });

    if (existingLineUser) {
      return this.syncBootstrapAdminRole(existingLineUser);
    }

    const normalizedEmail = profile.email?.trim().toLowerCase();

    if (normalizedEmail) {
      const existingEmailUser = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          address: true,
          role: true,
          lineUserId: true,
          linePictureUrl: true,
        },
      });

      if (existingEmailUser) {
        const linkedUser = await this.prisma.user.update({
          where: { id: existingEmailUser.id },
          data: {
            lineUserId: profile.sub,
            linePictureUrl: profile.picture ?? existingEmailUser.linePictureUrl,
          },
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            address: true,
            role: true,
            lineUserId: true,
            linePictureUrl: true,
          },
        });

        return this.syncBootstrapAdminRole(linkedUser);
      }
    }

    const syntheticPhone = `line_${profile.sub.slice(-10)}`;
    const syntheticEmail =
      normalizedEmail ?? `line_${profile.sub.toLowerCase()}@login.goose.local`;
    const passwordHash = await argon2.hash(randomBytes(24).toString('hex'));

    const createdUser = await this.prisma.user.create({
      data: {
        name: profile.name?.trim() || 'LINE User',
        phone: syntheticPhone,
        email: syntheticEmail,
        passwordHash,
        role: this.resolveBootstrapRole({
          email: syntheticEmail,
          phone: syntheticPhone,
        }),
        lineUserId: profile.sub,
        linePictureUrl: profile.picture ?? null,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        address: true,
        role: true,
        lineUserId: true,
        linePictureUrl: true,
      },
    });

    return this.syncBootstrapAdminRole(createdUser);
  }

  private resolveBootstrapRole(user: {
    email: string;
    phone: string;
  }): UserRole {
    return this.isBootstrapAdmin(user) ? UserRole.ADMIN : UserRole.CUSTOMER;
  }

  private async syncBootstrapAdminRole(
    user: AuthUserRecord,
  ): Promise<AuthUserRecord> {
    if (user.role === UserRole.ADMIN || !this.isBootstrapAdmin(user)) {
      return user;
    }

    return this.prisma.user.update({
      where: { id: user.id },
      data: { role: UserRole.ADMIN },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        address: true,
        role: true,
        lineUserId: true,
        linePictureUrl: true,
      },
    });
  }

  private isBootstrapAdmin(user: { email: string; phone: string }): boolean {
    const normalizedEmail = user.email.trim().toLowerCase();
    const normalizedPhone = user.phone.trim();
    const allowedEmails = (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const allowedPhones = (process.env.ADMIN_PHONES ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    return (
      allowedPhones.includes(normalizedPhone) ||
      allowedEmails.includes(normalizedEmail)
    );
  }

  private getPrismaErrorCode(error: unknown): string {
    if (!error || typeof error !== 'object' || !('code' in error)) {
      return '';
    }

    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : '';
  }

  private toAuthUser(user: AuthUserRecord): AuthUser {
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      address: user.address,
      role: user.role,
      isAdmin: user.role === UserRole.ADMIN,
    };
  }
}





