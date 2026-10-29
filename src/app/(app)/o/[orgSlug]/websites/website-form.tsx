"use client";

import { useActionState } from "react";
import { Button, Field, FormError } from "@/components/ui/form";
import type { FormState } from "../actions";

type Props = {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  clients: Array<{ id: string; name: string }>;
  defaults?: {
    name: string;
    url: string;
    clientId: string | null;
    monitoringEnabled: boolean;
    crawlMode: "AUTOMATIC" | "MANUAL";
  };
  submitLabel: string;
};

const CRAWL_MODES = [
  {
    value: "AUTOMATIC",
    label: "Automatic",
    help: "UpSiteHealth crawls the site every week, and soon after work that needs a crawl to confirm it is marked done (at most one such crawl a day).",
  },
  {
    value: "MANUAL",
    label: "Manual",
    help: "Crawls run only when someone starts one. Work marked done is confirmed by the next crawl you start.",
  },
] as const;

export function WebsiteForm({ action, clients, defaults, submitLabel }: Props) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-4">
      <FormError>{state?.error}</FormError>
      {state?.ok && (
        <p role="status" className="text-sm text-success-700">
          {state.ok}
        </p>
      )}
      <Field
        label="Name"
        name="name"
        required
        defaultValue={defaults?.name}
        errors={state?.fieldErrors?.name}
      />
      <Field
        label="URL"
        name="url"
        required
        placeholder="https://example.com"
        defaultValue={defaults?.url}
        errors={state?.fieldErrors?.url}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="clientId" className="text-sm font-medium">
          Client (optional)
        </label>
        <select
          id="clientId"
          name="clientId"
          defaultValue={defaults?.clientId ?? ""}
          className="rounded-md border border-line-strong bg-white px-3 py-2 text-sm"
        >
          <option value="">No client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {state?.fieldErrors?.clientId && (
          <p className="text-sm text-danger-700">
            {state.fieldErrors.clientId.join(" ")}
          </p>
        )}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Crawling</legend>
        {CRAWL_MODES.map((m) => (
          <label key={m.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="crawlMode"
              value={m.value}
              required
              defaultChecked={(defaults?.crawlMode ?? "AUTOMATIC") === m.value}
              className="mt-1"
            />
            <span>
              <span className="font-medium text-ink">{m.label}</span>
              <span className="block text-xs text-muted">{m.help}</span>
            </span>
          </label>
        ))}
        <p className="text-xs text-muted">
          Each crawl visits up to 100 pages. Uptime, SSL and DNS monitoring runs
          either way.
        </p>
      </fieldset>
      {defaults && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="monitoringEnabled"
            defaultChecked={defaults.monitoringEnabled}
          />
          Monitoring enabled
        </label>
      )}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
