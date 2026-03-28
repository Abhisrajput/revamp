import Link from 'next/link';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <Link href="/" className="inline-block mb-8">
          <h1 className="text-3xl font-bold text-primary-600 dark:text-primary-400">
            REVAMP
          </h1>
        </Link>

        {/* Auth Card */}
        {children}

        {/* Footer */}
        <p className="text-center text-sm text-slate-600 dark:text-slate-400 mt-8">
          By using REVAMP, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  );
}
