# REVAMP Web Frontend Architecture

## Overview

REVAMP is a modern Next.js 15 web application for AI-powered legacy application modernization. The application follows a feature-based architecture with clear separation of concerns between routing, components, and business logic.

## Technology Stack

### Frontend Framework
- **Next.js 15** - React framework with App Router
- **React 19** - UI library
- **TypeScript** - Type safety

### Styling & UI
- **Tailwind CSS v4** - Utility-first CSS
- **class-variance-authority** - Component variant management
- **next-themes** - Dark mode support
- **lucide-react** - Icon library
- **clsx + tailwind-merge** - Utility function composition

### State Management
- **Zustand** - Lightweight client state (auth, pipeline)
- **@tanstack/react-query** - Server state management
- **next-themes** - Theme persistence

### Development Tools
- **TypeScript** - Type safety
- **ESLint** - Code linting
- **PostCSS** - CSS processing

### Code Editor
- **@monaco-editor/react** - Code editing with syntax highlighting

## Directory Structure

```
apps/web/
├── app/                          # Next.js App Router pages
│   ├── layout.tsx               # Root layout with providers
│   ├── globals.css              # Global styles and Tailwind
│   ├── page.tsx                 # Landing page
│   ├── (auth)/                  # Auth route group
│   │   ├── layout.tsx           # Auth layout (centered card)
│   │   └── login/
│   │       └── page.tsx         # Login page
│   └── (dashboard)/             # Protected dashboard routes
│       ├── layout.tsx           # Dashboard layout with sidebar
│       ├── projects/
│       │   ├── page.tsx         # Projects list
│       │   └── [id]/
│       │       ├── page.tsx     # Project detail with stepper
│       │       └── pipeline/
│       │           └── page.tsx # Full pipeline view
│       ├── admin/
│       │   └── page.tsx         # Admin dashboard
│       └── settings/
│           └── page.tsx         # User settings
│
├── components/                   # Reusable React components
│   ├── ui/                      # Base UI components
│   │   ├── button.tsx           # Button component (CVA variants)
│   │   ├── card.tsx             # Card component
│   │   ├── input.tsx            # Input field
│   │   ├── badge.tsx            # Badge/tag component
│   │   ├── dialog.tsx           # Modal dialog (Radix UI)
│   │   └── sidebar.tsx          # Dashboard sidebar
│   ├── layout/
│   │   └── top-bar.tsx          # Top bar with user menu
│   ├── pipeline/                # Pipeline-specific components
│   │   ├── stage-stepper.tsx    # Horizontal stage stepper
│   │   └── stage-card.tsx       # Individual stage card
│   └── editor/
│       └── code-editor.tsx      # Monaco code editor wrapper
│
├── lib/                         # Utility functions and business logic
│   ├── api-client.ts            # Axios API client with interceptors
│   ├── query-client.ts          # React Query configuration
│   ├── utils.ts                 # Utility functions (cn)
│   ├── hooks/                   # Custom React hooks
│   │   ├── use-auth.ts          # Auth logic (login, logout)
│   │   └── use-projects.ts      # Projects CRUD hooks
│   └── stores/                  # Zustand stores
│       ├── auth-store.ts        # Auth state (token, user)
│       └── pipeline-store.ts    # Pipeline state management
│
├── middleware.ts                # Next.js middleware (auth redirect)
├── next.config.ts              # Next.js configuration
├── tsconfig.json               # TypeScript configuration
├── tailwind.config.ts          # Tailwind configuration
├── postcss.config.mjs          # PostCSS configuration
├── package.json                # Dependencies and scripts
├── .env.example                # Environment variables template
└── README.md                   # Project documentation
```

## Architecture Patterns

### 1. Route Groups (Parentheses Syntax)

Routes are organized into logical groups that don't affect the URL:

- `(auth)/` - Public authentication routes
- `(dashboard)/` - Protected application routes

This keeps related routes and layouts together while maintaining clean URLs.

### 2. Dynamic Routes

Project detail pages use dynamic segments:
- `/dashboard/projects/[id]` - Individual project view
- `/dashboard/projects/[id]/pipeline` - Project's pipeline

### 3. Layout Hierarchy

```
Root Layout
├── Auth Layout (centered card)
│   └── Login Page
└── Dashboard Layout (sidebar + topbar)
    ├── Projects
    ├── Admin
    └── Settings
```

### 4. API Client with Interceptors

The `apiClient` handles:
- Base URL configuration from environment
- Request middleware (adds Authorization header)
- Response middleware (401 logout handling)
- Error handling and retry logic

### 5. State Management Strategy

**Zustand Stores** (Client State):
- Authentication state (token, user)
- Pipeline state (stage status, project context)
- Persisted to localStorage

**React Query** (Server State):
- Projects list
- Project details
- Pipeline data
- Automatic caching and invalidation

### 6. Component Composition

UI components use **class-variance-authority** for variant management:

```tsx
const buttonVariants = cva(
  'base classes',
  {
    variants: {
      variant: { default: '...', outline: '...' },
      size: { sm: '...', lg: '...' }
    }
  }
);
```

## The 8-Stage Pipeline

Each project progresses through:

1. **Setup & Configuration** - Scope definition
2. **Intent Extraction** - Code analysis
3. **Business Capability Mining** - Architecture mapping
4. **Modernization Approach** - Strategy planning
5. **Behavior Lock-in** - BDD test creation
6. **Co-Create** - AI pair programming
7. **Continuous Modernization** - Production monitoring
8. **Parallel Run & Cutover** - Gradual migration

Visual representation:
- **StageStepper**: Horizontal progress indicator
- **StageCard**: Expandable detail cards per stage

## Authentication Flow

1. User navigates to `/login`
2. Submits email/password via `useAuth().login()`
3. API returns token + user object
4. Zustand store persists auth state
5. Middleware redirects to `/dashboard/projects`
6. Protected routes check `isAuthenticated`
7. Logout clears state and redirects to `/login`

## Styling System

### Tailwind v4 with CSS Variables

Global CSS defines theme tokens as custom properties:

```css
:root {
  --color-primary: #2d5af7;
  --bg-primary: #ffffff;
  --text-primary: #0f172a;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #0f172a;
    --text-primary: #f8fafc;
  }
}
```

### Color Palette

- **Primary**: Blues (#2d5af7) - CTAs, active states
- **Slate**: Neutrals - Backgrounds, borders, text
- **Accent**: Amber (#f59e0b) - Warnings, highlights
- **Green**: Success states
- **Red**: Destructive actions

### Dark Mode

- Automatic detection via `next-themes`
- Tailwind class-based (`dark:`)
- Persistent user preference

## API Integration

### Environment Configuration

```env
NEXT_PUBLIC_API_URL=http://localhost:3001/api
NEXT_PUBLIC_APP_NAME=REVAMP
```

### API Endpoints (Expected)

```
POST   /auth/login          - User login
GET    /auth/session        - Session validation
GET    /projects            - List projects
POST   /projects            - Create project
GET    /projects/:id        - Project detail
PUT    /projects/:id        - Update project
DELETE /projects/:id        - Delete project
GET    /projects/:id/pipeline - Pipeline detail
GET    /admin/health        - System health
GET    /admin/users         - Admin: List users
```

## Performance Optimizations

- **Route-based code splitting** via Next.js
- **Automatic image optimization** (configured)
- **Monaco Editor lazy loading** via dynamic import
- **React Query stale time**: 5 minutes
- **Tailwind v4 optimization** via optimizePackageImports

## Security

- **Auth middleware** protects `/dashboard` routes
- **Token-based API auth** via Authorization header
- **Automatic logout** on 401 responses
- **CORS-aware** API client
- **Type-safe** forms with Zod (ready for validation)

## Development Workflow

### Adding a New Page

```tsx
// app/(dashboard)/new-feature/page.tsx
'use client';

import { Card } from '@/components/ui/card';

export default function NewFeaturePage() {
  return (
    <div>
      <h1>New Feature</h1>
      <Card>...</Card>
    </div>
  );
}
```

### Creating a New Component

```tsx
// components/feature/my-component.tsx
import { Button } from '@/components/ui/button';

export function MyComponent() {
  return <Button>Click me</Button>;
}
```

### Adding API Integration

```tsx
// lib/hooks/use-feature.ts
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

export function useFeature(id: string) {
  return useQuery({
    queryKey: ['feature', id],
    queryFn: () => apiClient.get(`/features/${id}`),
  });
}
```

## Deployment

### Build
```bash
pnpm build
```

### Production Environment
Set `NEXT_PUBLIC_API_URL` to production API endpoint.

### Vercel Deployment
- Connect GitHub repo
- Configure environment variables
- Auto-deploy on push to main

## Future Enhancements

- [ ] Real-time WebSocket support for LLM streaming
- [ ] Advanced search and filtering
- [ ] Export/import project configurations
- [ ] Team collaboration features
- [ ] Advanced analytics dashboard
- [ ] Custom pipeline templates
