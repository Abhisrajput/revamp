'use client';

import Link from 'next/link';
import { ArrowRight, Zap, BarChart3, Code2, Shield, Layers, Cpu, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900">
      {/* Navigation */}
      <nav className="border-b border-slate-200 dark:border-slate-800 sticky top-0 z-50 bg-white/80 dark:bg-slate-950/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="text-2xl font-bold text-primary-600 dark:text-primary-400">
            REVAMP
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login">
              <Button variant="ghost">Sign In</Button>
            </Link>
            <Link href="/login">
              <Button>Get Started</Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 sm:py-32">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary-100 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800 mb-6">
            <Zap className="w-4 h-4 text-primary-600 dark:text-primary-400" />
            <span className="text-sm font-medium text-primary-600 dark:text-primary-400">
              AI-Powered Modernization
            </span>
          </div>

          <h1 className="text-5xl sm:text-6xl font-bold text-slate-900 dark:text-slate-50 mb-6 leading-tight">
            Transform Legacy Applications with AI
          </h1>

          <p className="text-xl text-slate-600 dark:text-slate-400 mb-8">
            REVAMP uses advanced AI to analyze, understand, and modernize your legacy systems in 8 strategic stages. Reduce technical debt while maintaining behavior integrity.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <Link href="/login">
              <Button size="lg" className="gap-2">
                Start Free Trial <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
            <Link href="#features">
              <Button variant="outline" size="lg">
                Learn More
              </Button>
            </Link>
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-8 shadow-xl">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-3xl font-bold text-primary-600 dark:text-primary-400">8</div>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Pipeline Stages</p>
              </div>
              <div>
                <div className="text-3xl font-bold text-primary-600 dark:text-primary-400">100%</div>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Behavior Lock-in</p>
              </div>
              <div>
                <div className="text-3xl font-bold text-primary-600 dark:text-primary-400">AI</div>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Co-Programming</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-bold text-slate-900 dark:text-slate-50 mb-4">
            Powerful Modernization Pipeline
          </h2>
          <p className="text-lg text-slate-600 dark:text-slate-400">
            Eight strategic stages to transform legacy code into modern systems
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            {
              icon: Code2,
              title: 'Setup & Configuration',
              description: 'Define scope, dependencies, and modernization goals'
            },
            {
              icon: Layers,
              title: 'Intent Extraction',
              description: 'Analyze code to understand original purpose and design'
            },
            {
              icon: BarChart3,
              title: 'Business Capability Mining',
              description: 'Map business capabilities and technical architecture'
            },
            {
              icon: Shield,
              title: 'Behavior Lock-in',
              description: 'Create comprehensive test suites to ensure correctness'
            },
            {
              icon: TrendingUp,
              title: 'Modernization Approach',
              description: 'Plan approach using modern patterns and technologies'
            },
            {
              icon: Cpu,
              title: 'Co-Create',
              description: 'Generate modernized code with AI pair programming'
            },
            {
              icon: Zap,
              title: 'Parallel Run & Cutover',
              description: 'Deploy safely with gradual traffic migration'
            },
            {
              icon: Code2,
              title: 'Continuous Modernization',
              description: 'Monitor and improve systems in production'
            },
          ].map((feature, idx) => (
            <div
              key={idx}
              className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-6 hover:shadow-lg transition-shadow"
            >
              <feature.icon className="w-8 h-8 text-primary-600 dark:text-primary-400 mb-4" />
              <h3 className="font-semibold text-slate-900 dark:text-slate-50 mb-2">
                {feature.title}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 bg-gradient-to-r from-primary-600 to-primary-700 dark:from-primary-900 dark:to-primary-800 rounded-2xl">
        <div className="text-center">
          <h2 className="text-4xl font-bold text-white mb-4">
            Ready to Modernize?
          </h2>
          <p className="text-xl text-primary-100 mb-8">
            Start transforming your legacy applications today
          </p>
          <Link href="/login">
            <Button
              size="lg"
              variant="outline"
              className="border-white text-white hover:bg-white/10"
            >
              Get Started Free
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center text-slate-600 dark:text-slate-400">
          <p>© 2024 REVAMP. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
