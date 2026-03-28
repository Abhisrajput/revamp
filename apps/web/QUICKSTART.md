# REVAMP Web Frontend - Quick Start Guide

## 5-Minute Setup

### 1. Install Dependencies
```bash
cd apps/web
pnpm install
```

### 2. Environment Setup
```bash
cp .env.example .env.local
```

### 3. Start Development Server
```bash
pnpm dev
```

Visit: **http://localhost:3000**

## Demo Credentials

Use these to log in:
- **Email**: `demo@revamp.ai`
- **Password**: `demo123`

## Project Structure at a Glance

```
apps/web/
├── app/                    # Pages (Next.js App Router)
│   ├── (auth)/login       # Login page
│   └── (dashboard)/        # Protected dashboard
│       ├── projects       # Projects list & detail
│       ├── admin          # Admin dashboard
│       └── settings       # User settings
│
├── components/             # Reusable React components
│   ├── ui/                # Base UI components
│   ├── layout/            # Layout components
│   ├── pipeline/          # Pipeline visualization
│   └── editor/            # Code editor
│
└── lib/                    # Business logic
    ├── api-client.ts      # HTTP client
    ├── hooks/             # Custom hooks
    └── stores/            # State management (Zustand)
```

## Key Pages

| Page | URL | Purpose |
|------|-----|---------|
| Landing | `/` | Public marketing page |
| Login | `/login` | User authentication |
| Projects | `/dashboard/projects` | View all projects |
| Project Detail | `/dashboard/projects/:id` | 8-stage pipeline view |
| Full Pipeline | `/dashboard/projects/:id/pipeline` | Detailed pipeline steps |
| Admin | `/dashboard/admin` | System health & users |
| Settings | `/dashboard/settings` | Profile & preferences |

## Available Scripts

```bash
# Development
pnpm dev          # Start dev server at localhost:3000

# Production
pnpm build        # Build for production
pnpm start        # Start production server

# Quality Assurance
pnpm lint         # Run ESLint
pnpm type-check   # TypeScript type checking

# Utilities
pnpm install      # Install dependencies
```

## Tech Stack

- **Next.js 15** - React framework
- **TypeScript** - Type safety
- **Tailwind CSS v4** - Styling
- **Zustand** - Client state
- **React Query** - Server state
- **Monaco Editor** - Code editing
- **Lucide React** - Icons

## Backend Integration

The app expects an API at the URL specified in `.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:3001/api
```

Update this to match your backend API endpoint.

## Authentication Flow

1. User logs in at `/login`
2. Credentials sent to `POST /auth/login`
3. Token + user stored in Zustand (localStorage)
4. Redirected to `/dashboard/projects`
5. All subsequent API requests include auth token

## The 8 Pipeline Stages

1. **Setup & Configuration** - Define scope and goals
2. **Intent Extraction** - Analyze legacy code
3. **Business Capability Mining** - Map capabilities
4. **Modernization Approach** - Plan strategy
5. **Behavior Lock-in** - Create test suites
6. **Co-Create** - AI pair programming
7. **Continuous Modernization** - Monitor & improve
8. **Parallel Run & Cutover** - Gradual migration

Each project progresses through these stages visually:
- Horizontal stepper shows overall progress
- Individual stage cards expand for details
- Status indicators show state (pending/in-progress/completed)

## Component Examples

### Button
```tsx
import { Button } from '@/components/ui/button';

<Button variant="default">Click me</Button>
<Button variant="outline">Outline</Button>
<Button variant="ghost">Ghost</Button>
```

### Card
```tsx
import { Card } from '@/components/ui/card';

<Card>
  <div className="p-6">Content</div>
</Card>
```

### Using API
```tsx
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

const { data } = useQuery({
  queryKey: ['projects'],
  queryFn: () => apiClient.get('/projects'),
});
```

### Auth
```tsx
import { useAuth } from '@/lib/hooks/use-auth';

const { login, logout, isAuthenticated } = useAuth();

await login(email, password);
logout();
```

## Styling

### Tailwind Classes
```tsx
<div className="flex items-center justify-between p-6 bg-white dark:bg-slate-900 rounded-lg">
  <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
    Title
  </h2>
</div>
```

### Dark Mode
The app automatically detects system preference. Users can toggle via the theme button in the top bar.

## Debugging

### Check API Calls
Open DevTools Network tab to see all API requests.

### Check Console Errors
Look for messages about:
- Missing API URL in `.env.local`
- 401 unauthorized (token expired)
- Network connectivity

### Type Checking
```bash
pnpm type-check
```

## Common Tasks

### Add a New Page
```tsx
// app/(dashboard)/feature/page.tsx
export default function FeaturePage() {
  return <div>Feature</div>;
}
```

### Add a New Component
```tsx
// components/feature/my-component.tsx
export function MyComponent() {
  return <div>Component</div>;
}
```

### Call an API
```tsx
import { apiClient } from '@/lib/api-client';

const response = await apiClient.get('/endpoint');
```

### Use State
```tsx
import { useAuthStore } from '@/lib/stores/auth-store';

const { user, token } = useAuthStore();
```

## Environment Variables

```env
# Required: Backend API URL
NEXT_PUBLIC_API_URL=http://localhost:3001/api

# Optional: App name
NEXT_PUBLIC_APP_NAME=REVAMP
```

## Performance Tips

1. **Lazy load components**: Use `React.lazy()` for large modules
2. **Optimize images**: Use Next.js `<Image>` component
3. **Cache API responses**: React Query handles this automatically
4. **Code splitting**: Next.js does this automatically per route

## Troubleshooting

### Port 3000 already in use
```bash
# Use different port
pnpm dev -- -p 3001
```

### Styles not loading
```bash
# Clear Next.js cache
rm -rf .next
pnpm dev
```

### API errors
1. Check `.env.local` has correct `NEXT_PUBLIC_API_URL`
2. Verify backend API is running
3. Check CORS configuration on backend

### Type errors
```bash
pnpm type-check
```

## Next Steps

1. ✅ Set up environment variables
2. ✅ Start development server
3. ✅ Test login with demo credentials
4. ⏭️ Build backend API integration
5. ⏭️ Customize branding (colors, logos)
6. ⏭️ Add WebSocket for real-time features
7. ⏭️ Deploy to production

## Documentation

- **README.md** - Full project overview
- **ARCHITECTURE.md** - Deep technical dive
- **SCAFFOLD_SUMMARY.md** - Complete file inventory

## Support

For issues or questions:
1. Check the documentation files above
2. Review the code comments
3. Check the Next.js docs: https://nextjs.org/docs

---

**Happy coding! 🚀**
