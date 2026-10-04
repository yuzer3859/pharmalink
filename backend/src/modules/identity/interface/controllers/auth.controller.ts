import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ChangePasswordCommand } from '../../application/commands/change-password.command';
import { ForgotPasswordCommand } from '../../application/commands/forgot-password.command';
import { LoginUserCommand } from '../../application/commands/login-user.command';
import { LogoutAllCommand, LogoutCommand } from '../../application/commands/logout.command';
import { RefreshTokenCommand } from '../../application/commands/refresh-token.command';
import { RegisterUserCommand } from '../../application/commands/register-user.command';
import { ResendOtpCommand } from '../../application/commands/resend-otp.command';
import { ResetPasswordCommand } from '../../application/commands/reset-password.command';
import { RevokeDeviceCommand } from '../../application/commands/revoke-device.command';
import { RevokeSessionCommand } from '../../application/commands/revoke-session.command';
import { VerifyOtpCommand } from '../../application/commands/verify-otp.command';
import { GetLoginHistoryQuery } from '../../application/queries/get-login-history.query';
import { ListDevicesQuery } from '../../application/queries/list-devices.query';
import { ListSessionsQuery } from '../../application/queries/list-sessions.query';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { LoginDto } from '../dtos/login.dto';
import { ChangePasswordDto, ForgotPasswordDto, ResetPasswordDto } from '../dtos/password.dto';
import { LogoutDto, RefreshDto } from '../dtos/refresh.dto';
import { RegisterDto } from '../dtos/register.dto';
import { ResendOtpDto, VerifyOtpDto } from '../dtos/verify-otp.dto';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';

/** Auth surface for module-01 §11.1/§11.2 (registration, OTP, login, token refresh, logout). */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerUser: RegisterUserCommand,
    private readonly verifyOtp: VerifyOtpCommand,
    private readonly resendOtp: ResendOtpCommand,
    private readonly loginUser: LoginUserCommand,
    private readonly refreshToken: RefreshTokenCommand,
    private readonly logout: LogoutCommand,
    private readonly logoutAll: LogoutAllCommand,
    private readonly listSessions: ListSessionsQuery,
    private readonly revokeSession: RevokeSessionCommand,
    private readonly listDevices: ListDevicesQuery,
    private readonly revokeDevice: RevokeDeviceCommand,
    private readonly getLoginHistory: GetLoginHistoryQuery,
    private readonly forgotPassword: ForgotPasswordCommand,
    private readonly resetPassword: ResetPasswordCommand,
    private readonly changePassword: ChangePasswordCommand,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto) {
    return this.registerUser.execute(dto);
  }

  @Public()
  @Post('verify-otp')
  verifyOtpHandler(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    return this.verifyOtp.execute({
      ...dto,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Public()
  @Post('resend-otp')
  resendOtpHandler(@Body() dto: ResendOtpDto) {
    return this.resendOtp.execute(dto);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.loginUser.execute({
      ...dto,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  @Public()
  @Post('token/refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.refreshToken.execute(dto);
  }

  @Public()
  @Post('password/forgot')
  forgot(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.forgotPassword.execute({ identifier: dto.identifier, ip: req.ip ?? null });
  }

  @Public()
  @Post('password/reset')
  reset(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.resetPassword.execute({
      identifier: dto.identifier,
      code: dto.code,
      newPassword: dto.newPassword,
      ip: req.ip ?? null,
    });
  }

  @Post('password/change')
  change(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    return this.changePassword.execute({
      userId: user.userId,
      oldPassword: dto.oldPassword,
      newPassword: dto.newPassword,
      ip: req.ip ?? null,
    });
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutHandler(@Body() dto: LogoutDto): Promise<void> {
    await this.logout.execute(dto.refreshToken);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAllHandler(@CurrentUser() user: AuthenticatedPrincipal): Promise<void> {
    await this.logoutAll.execute(user.userId);
  }

  @Get('sessions')
  sessions(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.listSessions.execute(user.userId);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSessionHandler(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    await this.revokeSession.execute(user.userId, id);
  }

  @Get('devices')
  devices(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.listDevices.execute(user.userId);
  }

  @Delete('devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeDeviceHandler(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    await this.revokeDevice.execute(user.userId, id);
  }

  @Get('login-history')
  loginHistory(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    return this.getLoginHistory.execute(
      user.userId,
      page ? Number(page) : undefined,
      size ? Number(size) : undefined,
    );
  }
}
