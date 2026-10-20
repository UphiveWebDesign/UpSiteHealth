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
  };
  submitLabel: string;
};

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
