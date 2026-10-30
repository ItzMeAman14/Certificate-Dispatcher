# Certificate Dispatcher

An enterprise-grade full-stack solution designed to streamline, automate, and track the bulk dispatching of personalized certificates to students and participants directly from Salesforce.

---

## Overview

**Certificate Dispatcher** eliminates manual work when distributing certificates for graduations, internships, training programs, and workshops. It connects directly to your Salesforce CRM, matches students with their attached certificate documents, generates personalized HTML emails via an intuitive block editor, and delivers them via a resilient background outbox worker.

Every delivery is tracked from queuing to delivery, complete with live progress metrics, retry capabilities, and bounce/suppression handling.

---

## Key Features

### 1. Salesforce CRM Integration
- **Flexible Authentication**: Connect to Salesforce orgs via OAuth 2.0 (Client Credentials Flow), Access Token, or Username/Password.
- **Dynamic Field Mapping**: Choose your source object (e.g., `Contact`, `Student__c`) and map recipient email fields.
- **Automated Certificate Discovery**: Automatically locates and downloads certificate attachments (`ContentVersion` / `ContentDocumentLink`) associated with each student record.

### 2. Block-Based Visual Email Template Builder
- **Customizable Layout**: Drag, arrange, and style blocks including:
  - Organization / Brand Logo
  - Custom Headings & Paragraph Text
  - Callout Badges
  - Decorative Dividers
  - Sign-off & Footer
- **Live Placeholder Merging**: Automatically interpolates personalized student data:
  - `{{studentName}}` – Recipient's full name
  - `{{studentEmail}}` – Recipient's email address
  - `{{fileName}}` – Certificate file attachment name
  - `{{companyName}}` – Sponsoring organization / company
  - `{{hrName}}` – Signatory / HR contact
  - `{{year}}` – Current academic / calendar year
- **Email-Safe HTML Output**: Produces cross-client compatible HTML with inline styling and a clean plain-text fallback.

### 3. High-Throughput Durable Outbox Queue & Worker
- **Scale to 500–1,000+ Recipients**: Dispatches large batches without HTTP request timeouts or gateway failures.
- **Durable Storage**: Powered by NeonDB (PostgreSQL) with connection pooling and an automatic local file-based database fallback (`data/store.json`).
- **ACID Concurrency**: Employs `FOR UPDATE SKIP LOCKED` for lock-free, concurrent multi-worker processing.
- **Strict Idempotency**: Prevents duplicate sends using unique idempotency keys per recipient and campaign.
- **Configurable Rate Limiting**: Regulates dispatch speed (`EMAIL_RATE_LIMIT_PER_SEC` and `WORKER_CONCURRENCY`) to comply with SMTP provider thresholds and avoid spam throttling.
- **Smart Retries & Error Handling**: Exponential backoff for transient network issues; immediate classification for permanent 5xx mailbox errors.

### 4. Real-Time Tracking & Progress Dashboard
- **Live Progress Monitor**: Displays active dispatch progress bar, counts processed, queued, sent, and failed items, with immediate status updates and dismissible notifications.
- **Detailed Delivery Status Badges**:
  - `Not Sent` – Student has a certificate ready to dispatch.
  - `Queued` / `Sending...` – In queue or actively transmitting through the background worker.
  - `Sent (Accepted)` – Handed off and accepted by the SMTP mail relay.
  - `Delivered` – Confirmed delivered via webhook events.
  - `Bounced` / `Failed` – Failed delivery with exact error audit messages.
- **Selective Retry**: One-click retry for failed or bounced emails without re-sending to recipients who already received their certificates.
- **Filtering & Search**: Instant client-side search by name, email, or student ID, combined with status filter tabs (All, Sent, Not Sent, Failed, Bounced, Ready to Send, Missing Certificate).

### 5. Delivery Webhooks & Suppression Management
- **Inbound Webhook Verification**: Compatible with SendGrid, Resend, and AWS SES webhook standards with HMAC-SHA256 signature verification.
- **Automatic Suppression List**: Automatically suppresses addresses that generate hard bounces to safeguard sender domain reputation.

### 6. Security & Credential Protection
- **Authenticated Encryption**: Sensitive credentials (Salesforce client secrets, tokens, SMTP passwords) are encrypted using AES-256-GCM.
- **Session Protection**: Scrypt password hashing with HTTP-only secure cookie sessions.
- **HTTP Security**: Hardened using Helmet headers and CORS protection.

---

## Architecture & Tech Stack

```mermaid
flowchart TD
    subgraph Frontend["Frontend (React 19 + TypeScript + Vite)"]
        UI[Certificate Dispatcher Dashboard]
        Editor[Email Template Builder]
        Settings[Settings & Salesforce Modal]
    end

    subgraph Backend["Backend (Node.js / Express 5)"]
        API[Express REST API]
        QueueWorker[Background Outbox Worker]
        SFClient[Salesforce Client / jsforce]
        Mailer[Nodemailer Transport Pool]
    end

    subgraph Storage["Data Tier"]
        DB[(PostgreSQL / NeonDB)]
        FileFallback[(Local store.json Fallback)]
    end

    subgraph External["External Services"]
        SF[Salesforce Org / Dev Edition]
        SMTP[SMTP Relay / Gmail / Outlook]
        WebhookProvider[Email Provider Webhooks]
    end

    UI -->|HTTP / REST| API
    Editor -->|Save Template| API
    Settings -->|Manage Credentials| API
    
    API -->|Persist Records| DB
    API -.->|Offline / Local| FileFallback
    API -->|Fetch Contacts & Files| SFClient
    SFClient -->|SOQL / REST| SF

    QueueWorker -->|Poll Runnable Jobs| DB
    QueueWorker -->|Download VersionData| SFClient
    QueueWorker -->|Dispatch Email + Attachment| Mailer
    Mailer -->|TLS / SMTP| SMTP

    WebhookProvider -->|Delivery / Bounce Events| API
```

### Technologies Used

| Layer | Technologies |
|---|---|
| **Frontend** | React 19, TypeScript, Vite, Tailwind CSS v4, Lucide React |
| **Backend** | Node.js, Express 5, `jsforce`, `nodemailer`, `pg` (PostgreSQL), `helmet`, `cors` |
| **Database** | NeonDB (Serverless PostgreSQL) with local JSON storage fallback |
| **Security** | Scrypt password hashing, AES-256-GCM authenticated encryption |

---

## Project Structure

```text
Certificate Dispatcher/
├── backend/
│   ├── images/              # Assets & logos
│   ├── lib/
│   │   ├── errors.js        # Standardized HTTP error classes
│   │   ├── queue.js         # Durable background queue worker
│   │   ├── salesforce.js    # Salesforce SOQL query & file download helpers
│   │   ├── store.js         # Database layer (PostgreSQL / local fallback)
│   │   └── webhook.js       # Inbound webhook normalization & reconciliation
│   ├── test/
│   │   └── app.test.js      # Backend integration & unit tests
│   ├── security.js          # Cryptographic hashing & encryption utilities
│   ├── server.js            # Express API server & route handlers
│   └── package.json
│
├── certificate-dispatcher/  # Frontend application
│   ├── public/              # Static icons and assets
│   ├── src/
│   │   ├── components/
│   │   │   ├── AuthScreen.tsx             # Login / Sign-up screen
│   │   │   ├── CertificateDispatcher.tsx  # Main dashboard & delivery table
│   │   │   ├── ConnectSalesforce.tsx      # Salesforce connection modal
│   │   │   ├── EmailTemplateEditor.tsx    # Drag-and-drop template designer
│   │   │   ├── Footer.tsx                 # Application footer
│   │   │   └── SettingsModal.tsx          # SMTP & field mapping configuration
│   │   ├── api.ts                         # Type-safe API client & fetch wrapper
│   │   ├── App.tsx                        # Root layout & auth state management
│   │   └── main.tsx
│   ├── package.json
│   └── vite.config.ts
│
└── data/                    # Local storage directory (secret key & fallback DB)
```

---

## Getting Started

### Prerequisites
- **Node.js** (v18 or higher recommended)
- **npm** or **pnpm**
- A **Salesforce** Developer or Production Org (with Connected App or API access)
- An **SMTP account** (e.g., Google App Password, Outlook 365, or dedicated SMTP provider)
- *(Optional)* A **PostgreSQL / NeonDB** instance

---

### Backend Setup

1. Open a terminal and navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables in `.env`:
   ```env
   PORT=3000
   DATABASE_URL=postgresql://user:password@host/neondb?sslmode=require
   WORKER_CONCURRENCY=3
   EMAIL_RATE_LIMIT_PER_SEC=5
   WEBHOOK_SECRET=your_optional_webhook_secret
   ```
   *(Note: If `DATABASE_URL` is omitted, the backend automatically operates using the local file database in `data/store.json`.)*

4. Run tests:
   ```bash
   npm test
   ```

5. Start the backend server:
   ```bash
   npm start
   ```
   The backend API will run on `http://localhost:3000`.

---

### Frontend Setup

1. Open a second terminal and navigate to the frontend directory:
   ```bash
   cd certificate-dispatcher
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the Vite development server:
   ```bash
   npm run dev
   ```

4. Open your browser and navigate to the printed local URL (typically `http://localhost:5173`).

---

## Typical User Workflow

1. **Sign Up / Log In**: Create your local administrator account.
2. **Connect Salesforce**: Open **Connect Salesforce**, enter your Salesforce credentials or Connected App details, and establish a verified connection.
3. **Configure Settings**:
   - Provide your SMTP sender email and app password.
   - Set the default sender name, HR signatory name, and optional logo URL.
   - Confirm your Salesforce object (`Contact`) and email field (`Email`).
4. **Customize Email Template**:
   - Click **Edit Template** to customize subject lines and email content blocks.
   - Use dynamic merge tags (`{{studentName}}`, `{{fileName}}`, etc.) to personalize every message.
5. **Dispatch Certificates**:
   - **Single Send**: Click **Send** next to any specific student row.
   - **Bulk Send Selected**: Tick multiple students and click **Send Selected (N)**.
   - **Send All Ready**: Click **Send All Ready** to enqueue certificates for every verified student with an attached certificate.
6. **Monitor & Retry**:
   - Watch live progress in the campaign banner.
   - View per-student delivery statuses.
   - Click **Retry Failed** if any addresses bounce or experience delivery issues.

