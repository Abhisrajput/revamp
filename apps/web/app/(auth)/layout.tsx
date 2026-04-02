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
          <div className="flex items-center gap-3">
            <span className="text-2xl font-bold text-slate-400 tracking-wider">TAVANT</span>
            <span className="text-slate-600 dark:text-slate-500">|</span>
            <div className="w-8 h-8 rounded-lg bg-primary-500 flex items-center justify-center">
              <span className="text-white text-sm font-bold">&lt;/&gt;</span>
            </div>
            <span className="text-2xl font-bold text-slate-900 dark:text-slate-50">AIgnite</span>
          </div>
        </Link>

        {/* Auth Card */}
        {children}

        {/* Footer */}
        <p className="text-center text-sm text-slate-600 dark:text-slate-400 mt-8">
          By using AIgnite, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  );
}
