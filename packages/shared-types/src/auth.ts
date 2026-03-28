/**
 * Authentication and authorization types for REVAMP
 */

export enum UserRole {
  ADMIN = 'ADMIN',
  ARCHITECT = 'ARCHITECT',
  ENGINEER = 'ENGINEER',
  REVIEWER = 'REVIEWER',
  VIEWER = 'VIEWER',
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  organizationId: string;
  avatar?: string;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
  tokenType: 'Bearer';
}

export interface LoginRequest {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface LoginResponse {
  user: User;
  tokens: AuthTokens;
}

export interface Session {
  id: string;
  userId: string;
  user: User;
  token: string;
  refreshToken: string;
  expiresAt: string;
  createdAt: string;
  ipAddress?: string;
  userAgent?: string;
  isActive: boolean;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

export interface VerifyTokenResponse {
  valid: boolean;
  user?: User;
  expiresIn?: number;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface ResetPasswordRequest {
  email: string;
}

export interface ResetPasswordConfirm {
  token: string;
  newPassword: string;
  confirmPassword: string;
}
