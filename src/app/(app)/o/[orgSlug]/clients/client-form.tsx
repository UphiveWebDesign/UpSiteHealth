"use client";

import { useActionState } from "react";
import { Button, Field, FormError } from "@/components/ui/form";
import type { FormState } from "../actions";

export function ClientForm({
  action,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="flex max-w-lg flex-col gap-4">
      <FormError>{state?.error}</FormError>
      {state?.ok && <p className="text-sm text-emerald-700">{state.ok}</p>}
      <Field
        label="Name"
        name="name"
        required
        errors={state?.fieldErrors?.name}
      />
      <Field
        label="Email"
        name="email"
        type="email"
        errors={state?.fieldErrors?.email}
      />
      <Field
        label="Company"
        name="company"
        errors={state?.fieldErrors?.company}
      />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add client"}
        </Button>
      </div>
    </form>
  );
}
