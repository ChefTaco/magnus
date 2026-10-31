import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { WebhookForm } from '../webhook-form';

export default function NewWebhookPage() {
  return (
    <div>
      <div className="mb-8">
        <Link href="/webhooks" className="text-xs text-text-muted hover:text-accent mb-3 inline-flex items-center gap-1">
          <ArrowLeft className="h-3 w-3" /> Back to webhooks
        </Link>
        <h1 className="text-2xl font-semibold text-accent mt-2">New Webhook</h1>
        <p className="text-sm mt-1 text-text-muted">
          Configure a new endpoint to receive event notifications
        </p>
      </div>
      <WebhookForm />
    </div>
  );
}
