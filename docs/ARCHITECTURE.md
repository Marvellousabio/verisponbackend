# Architecture

## Overview

Verispon is a WhatsApp-first escrow platform. This document describes the frontend architecture.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Next.js Application                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Landing     │  │  Dashboard   │  │  WhatsApp Flow   │  │
│  │  Page        │  │  Workspace   │  │  Demo/Entry      │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│         │                 │                  │              │
│         ▼                 ▼                  ▼              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Shared Packages                         │    │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────────────┐  │    │
│  │  │   UI     │ │  Utils   │ │  Domain/State      │  │    │
│  │  │Components │ │Functions │ │  Machines          │  │    │
│  │  └──────────┘ └──────────┘ └────────────────────┘  │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Layered Architecture

### 1. Presentation Layer (`apps/web/src/components`)

UI components organized by feature:

- `landing/` - Landing page sections (Header, Hero, Features, Pricing, FAQ, etc.)
- `dashboard/` - Dashboard components (Sidebar, Header, SummaryCards, TransactionTable)
- `ui/` - Reusable UI primitives (Button, Badge, StatusBadge)

**Guidelines:**
- Presentational components should be pure functions
- Keep components small and focused (Single Responsibility)
- Use composition over props drilling

### 2. Domain Layer (`apps/web/src/domain`)

Core business logic and type definitions:

- `escrow.ts` - Escrow state machine and transition validation
- `whatsapp.ts` - WhatsApp session types, step definitions, and validation

**Guidelines:**
- Domain types are the source of truth
- State transitions are explicit and validated
- No framework dependencies in domain layer

### 3. Application Layer (`apps/web/src/app`)

Next.js App Router routes and page components:

- `page.tsx` - Landing page
- `dashboard/page.tsx` - Dashboard workspace
- `whatsapp/page.tsx` - WhatsApp entry point
- `api/` - API routes (webhooks, transactions)

**Guidelines:**
- Pages orchestrate components
- Keep business logic out of page components
- Use server components where possible

### 4. Infrastructure Layer (`apps/web/src/lib`)

External integrations and utilities:

- `whatsapp-bot.ts` - WhatsApp bot state machine
- `whatsapp-webhook.ts` - Meta webhook parsing and signature verification
- `meta-whatsapp.ts` - Meta WhatsApp API client
- `meta-config.ts` - Meta configuration
- `session-store.ts` - Session storage interface
- `postgres-store.ts` - PostgreSQL session and escrow storage
- `escrow-store.ts` - Escrow storage interface
- `escrow-transactions.ts` - Dashboard transaction management
- `image-compression.ts` - Client-side image compression
- `whatsapp-link.ts` - WhatsApp URL generation

**Guidelines:**
- All external integrations are in this layer
- Use interfaces for storage abstractions
- Validate untrusted input at boundaries

### 5. Shared Packages

Reusable, framework-agnostic packages:

- `@verispon/ui` - UI component library
- `@verispon/utils` - Utility functions
- `@verispon/tsconfig` - TypeScript configurations
- `@verispon/eslint-config` - ESLint configuration
- `@verispon/tailwind-config` - Tailwind CSS configuration

## Data Flow

### Escrow Lifecycle

```
User Action → WhatsApp Bot → Session Store → Escrow Store → Dashboard
                ↓
          Meta Webhook → Signature Verification → Bot Handler → Reply
```

### Transaction Flow

```
Dashboard → Escrow Transactions (localStorage) → API → Server Store
                ↓
          PostgreSQL (optional)
```

## State Management

- **Server Components:** Data fetching with async/await
- **Client Components:** React hooks (useState, useEffect, useCallback)
- **Persistence:** localStorage for client-side, file system for server-side, PostgreSQL for production

## Error Handling

- Domain errors: Type-safe error returns
- Network errors: Graceful degradation with fallbacks
- Validation errors: User-friendly messages
- Webhook errors: Idempotent processing

## Performance

- **Code Splitting:** Next.js automatic route-based splitting
- **Image Optimization:** Next.js Image component with WebP/AVIF
- **Caching:** Route-level caching with `cache: "no-store"` for dynamic data
- **Bundle Optimization:** `optimizePackageImports` for UI components
- **Render Optimization:** `React.memo` for expensive components

## Security

- Meta webhook signature verification
- Input validation at all boundaries
- No secrets in client-side code
- CSRF protection via Next.js defaults
- Environment variable validation