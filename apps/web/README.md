# REVAMP Web Frontend

AI-powered legacy application modernizer web interface.

## Getting Started

### Prerequisites
- Node.js 18+ (LTS recommended)
- pnpm (recommended) or npm

### Installation

```bash
# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env.local

# Update .env.local with your API URL
```

### Development

```bash
# Start the development server
pnpm dev

# Run type checking
pnpm type-check

# Run linting
pnpm lint
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Demo Credentials

- Email: `demo@revamp.ai`
- Password: `demo123`

## Build & Deployment

```bash
# Build for production
pnpm build

# Start production server
pnpm start
```

## Architecture

- **Framework**: Next.js 15 (App Router)
- **Styling**: Tailwind CSS v4
- **State Management**: Zustand (client) + React Query (server)
- **Type Safety**: TypeScript
- **Code Editor**: Monaco Editor
- **Dark Mode**: next-themes
- **UI Components**: Custom components with class-variance-authority

## Project Structure

```
app/
  ├── (auth)/           # Authentication routes
  ├── (dashboard)/      # Protected dashboard routes
  └── page.tsx          # Landing page

components/
  ├── ui/               # Reusable UI components
  ├── layout/           # Layout components
  ├── pipeline/         # Pipeline-specific components
  └── editor/           # Code editor component

lib/
  ├── hooks/            # Custom React hooks
  ├── stores/           # Zustand stores
  ├── api-client.ts     # API client with auth
  ├── query-client.ts   # React Query setup
  └── utils.ts          # Utility functions
```

## The 8-Stage Pipeline

1. **Setup & Configuration** - Define scope and goals
2. **Intent Extraction** - Analyze code intent
3. **Business Capability Mining** - Map capabilities
4. **Modernization Approach** - Plan strategy
5. **Behavior Lock-in** - Create test suites (BDD)
6. **Co-Create** - AI pair programming
7. **Continuous Modernization** - Monitor & improve
8. **Parallel Run & Cutover** - Gradual migration

## Environment Variables

```
NEXT_PUBLIC_API_URL=http://localhost:3001/api
NEXT_PUBLIC_APP_NAME=REVAMP
```

## License

Copyright © 2024 REVAMP. All rights reserved.
