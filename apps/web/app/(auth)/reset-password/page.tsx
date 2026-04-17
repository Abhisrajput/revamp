'use client';

import { useState, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@revamp/ui/components/button';
import { Input } from '@revamp/ui/components/input';
import { Card } from '@revamp/ui/components/card';
import { Loader2, ArrowLeft, CheckCircle2, KeyRound, Mail } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

// --- Password strength ---

type PasswordStrength = 'weak' | 'fair' | 'good' | 'strong';

function evaluatePasswordStrength(password: string): { strength: PasswordStrength; score: number; feedback: string } {
  let score = 0;
  const feedback: string[] = [];

  if (password.length >= 8) score++;
  else feedback.push('At least 8 characters');

  if (password.length >= 12) score++;

  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  else feedback.push('Mix of upper and lower case');

  if (/\d/.test(password)) score++;
  else feedback.push('At least one number');

  if (/[^a-zA-Z0-9]/.test(password)) score++;
  else feedback.push('At least one special character');

  const strength: PasswordStrength =
    score <= 1 ? 'weak' :
    score <= 2 ? 'fair' :
    score <= 3 ? 'good' :
    'strong';

  return {
    strength,
    score: Math.min(score, 5),
    feedback: feedback.length > 0 ? feedback.join(', ') : 'Strong password',
  };
}

const STRENGTH_COLORS: Record<PasswordStrength, string> = {
  weak: 'bg-red-500',
  fair: 'bg-yellow-500',
  good: 'bg-blue-500',
  strong: 'bg-green-500',
};

const STRENGTH_LABELS: Record<PasswordStrength, string> = {
  weak: 'Weak',
  fair: 'Fair',
  good: 'Good',
  strong: 'Strong',
};

// --- Page ---
//
// useSearchParams() requires a Suspense boundary at build time (Next 14+).
// Wrap the inner view accordingly; the outer component is the one Next exports.

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<Card className="bg-white dark:bg-slate-900"><div className="p-8">Loading…</div></Card>}>
      <ResetPasswordInner />
    </Suspense>
  );
}

function ResetPasswordInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  // Determine which view to show
  const isConfirmView = !!token;

  return (
    <Card className="bg-white dark:bg-slate-900">
      <div className="p-8">
        {isConfirmView ? (
          <ConfirmPasswordView token={token!} />
        ) : (
          <RequestResetView />
        )}

        <p className="text-center text-sm text-slate-600 dark:text-slate-400 mt-6">
          <Link href="/login" className="text-primary-600 dark:text-primary-400 hover:underline font-medium inline-flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" />
            Back to Sign In
          </Link>
        </p>
      </div>
    </Card>
  );
}

// --- Request Reset View ---

function RequestResetView() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await apiClient.post('/auth/reset-password/request', { email });
      setSuccess(true);
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ||
        err?.response?.data?.error ||
        'Failed to send reset email. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="text-center">
        <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-4">
          <Mail className="w-6 h-6 text-green-600 dark:text-green-400" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50 mb-2">
          Check Your Email
        </h2>
        <p className="text-slate-600 dark:text-slate-400 text-sm">
          If an account exists for <strong>{email}</strong>, we have sent a password reset link.
          Please check your inbox and spam folder.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center mx-auto mb-4">
          <KeyRound className="w-6 h-6 text-primary-600 dark:text-primary-400" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50 mb-2">
          Reset Password
        </h2>
        <p className="text-slate-600 dark:text-slate-400 text-sm">
          Enter your email address and we will send you a link to reset your password.
        </p>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
            Email Address
          </label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            required
          />
        </div>

        <Button type="submit" className="w-full" disabled={loading || !email.trim()}>
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Sending...
            </>
          ) : (
            'Send Reset Link'
          )}
        </Button>
      </form>
    </>
  );
}

// --- Confirm Password View ---

function ConfirmPasswordView({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const passwordInfo = useMemo(() => evaluatePasswordStrength(password), [password]);
  const passwordsMatch = password === confirmPassword;
  const canSubmit = password.length >= 8 && passwordsMatch && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setError('');
    setLoading(true);

    try {
      await apiClient.post('/auth/reset-password/confirm', {
        token,
        password,
      });
      setSuccess(true);
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ||
        err?.response?.data?.error ||
        'Failed to reset password. The link may have expired.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="text-center">
        <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-400" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50 mb-2">
          Password Reset Successful
        </h2>
        <p className="text-slate-600 dark:text-slate-400 text-sm mb-6">
          Your password has been updated. You can now sign in with your new password.
        </p>
        <Link href="/login">
          <Button className="w-full">Sign In</Button>
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center mx-auto mb-4">
          <KeyRound className="w-6 h-6 text-primary-600 dark:text-primary-400" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50 mb-2">
          Set New Password
        </h2>
        <p className="text-slate-600 dark:text-slate-400 text-sm">
          Choose a strong password for your account.
        </p>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
            New Password
          </label>
          <Input
            id="password"
            type="password"
            placeholder="Minimum 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            required
            minLength={8}
          />
          {/* Password strength indicator */}
          {password.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className={cn(
                      'h-1 flex-1 rounded-full transition-colors',
                      i <= passwordInfo.score
                        ? STRENGTH_COLORS[passwordInfo.strength]
                        : 'bg-slate-200 dark:bg-slate-700',
                    )}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between">
                <span className={cn(
                  'text-[10px] font-medium',
                  passwordInfo.strength === 'weak' && 'text-red-500',
                  passwordInfo.strength === 'fair' && 'text-yellow-500',
                  passwordInfo.strength === 'good' && 'text-blue-500',
                  passwordInfo.strength === 'strong' && 'text-green-500',
                )}>
                  {STRENGTH_LABELS[passwordInfo.strength]}
                </span>
                <span className="text-[10px] text-slate-400">{passwordInfo.feedback}</span>
              </div>
            </div>
          )}
        </div>

        <div>
          <label htmlFor="confirm-password" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
            Confirm Password
          </label>
          <Input
            id="confirm-password"
            type="password"
            placeholder="Re-enter your password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={loading}
            required
          />
          {confirmPassword.length > 0 && !passwordsMatch && (
            <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
          )}
          {confirmPassword.length > 0 && passwordsMatch && (
            <p className="text-xs text-green-500 mt-1 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              Passwords match
            </p>
          )}
        </div>

        <Button type="submit" className="w-full" disabled={!canSubmit}>
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Resetting...
            </>
          ) : (
            'Reset Password'
          )}
        </Button>
      </form>
    </>
  );
}
