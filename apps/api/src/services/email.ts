/**
 * Email Service — Resend integration for transactional email.
 *
 * Used for:
 *   - OTP delivery
 *   - Password reset tokens
 *   - Project invitation notifications
 *
 * Configuration:
 *   - RESEND_API_KEY: Resend API key (required for email delivery)
 *   - EMAIL_FROM: Sender address (default: noreply@revamp.io)
 *
 * Graceful degradation: if RESEND_API_KEY is not set, all methods log
 * warnings instead of failing. This allows the platform to function
 * without email in development environments.
 */

// ─── TYPES ──────────────────────────────────────────────────────

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ─── SERVICE ────────────────────────────────────────────────────

class EmailService {
  private apiKey: string | undefined;
  private fromAddress: string;
  private resendClient: any = null;
  private initialized = false;

  constructor() {
    this.apiKey = process.env.RESEND_API_KEY;
    this.fromAddress = process.env.EMAIL_FROM || "noreply@revamp.io";
  }

  /**
   * Lazy-initialize the Resend client to avoid import failures
   * when the package is not installed.
   */
  private async ensureClient(): Promise<boolean> {
    if (this.initialized) return this.resendClient !== null;
    this.initialized = true;

    if (!this.apiKey) {
      console.warn("[Email] RESEND_API_KEY not configured — email delivery disabled");
      return false;
    }

    try {
      const { Resend } = await import("resend" as string) as { Resend: new (key: string) => any };
      this.resendClient = new Resend(this.apiKey);
      return true;
    } catch {
      console.warn("[Email] resend package not available — email delivery disabled");
      return false;
    }
  }

  /**
   * Send a raw email. Returns success status.
   */
  async send(options: SendEmailOptions): Promise<EmailResult> {
    const available = await this.ensureClient();
    if (!available) {
      console.warn(
        `[Email] Would send "${options.subject}" to ${options.to} (email service unavailable)`,
      );
      return { success: false, error: "Email service not configured" };
    }

    try {
      const result = await this.resendClient.emails.send({
        from: this.fromAddress,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      });

      return { success: true, messageId: result?.data?.id };
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      console.error(`[Email] Failed to send "${options.subject}" to ${options.to}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Send OTP code to user for authentication.
   */
  async sendOTP(email: string, otp: string): Promise<EmailResult> {
    return this.send({
      to: email,
      subject: "Your REVAMP verification code",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Verification Code</h2>
          <p>Your one-time verification code is:</p>
          <div style="background: #f4f4f5; border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; font-family: monospace;">${otp}</span>
          </div>
          <p style="color: #666; font-size: 14px;">This code expires in 10 minutes. Do not share it with anyone.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
          <p style="color: #999; font-size: 12px;">If you did not request this code, you can safely ignore this email.</p>
        </div>
      `,
      text: `Your REVAMP verification code is: ${otp}\n\nThis code expires in 10 minutes.`,
    });
  }

  /**
   * Send password reset link/token to user.
   */
  async sendPasswordReset(email: string, token: string): Promise<EmailResult> {
    const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

    return this.send({
      to: email,
      subject: "Reset your REVAMP password",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Password Reset</h2>
          <p>We received a request to reset your password. Click the button below to choose a new password:</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${resetUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Reset Password</a>
          </div>
          <p style="color: #666; font-size: 14px;">This link expires in 1 hour.</p>
          <p style="color: #666; font-size: 14px;">If the button doesn't work, copy and paste this URL into your browser:</p>
          <p style="color: #2563eb; font-size: 12px; word-break: break-all;">${resetUrl}</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
          <p style="color: #999; font-size: 12px;">If you did not request a password reset, you can safely ignore this email.</p>
        </div>
      `,
      text: `Reset your REVAMP password by visiting: ${resetUrl}\n\nThis link expires in 1 hour.`,
    });
  }

  /**
   * Send project invitation email.
   */
  async sendInvitation(
    email: string,
    inviterName: string,
    projectName: string,
    role: string,
  ): Promise<EmailResult> {
    const loginUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/login`;

    return this.send({
      to: email,
      subject: `You've been invited to "${projectName}" on REVAMP`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Project Invitation</h2>
          <p><strong>${inviterName}</strong> has invited you to join the project <strong>"${projectName}"</strong> as a <strong>${role}</strong>.</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${loginUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Open REVAMP</a>
          </div>
          <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
          <p style="color: #999; font-size: 12px;">REVAMP — AI-Powered Legacy Application Modernizer</p>
        </div>
      `,
      text: `${inviterName} has invited you to join "${projectName}" as a ${role}. Log in at: ${loginUrl}`,
    });
  }
}

// Singleton
export const emailService = new EmailService();
