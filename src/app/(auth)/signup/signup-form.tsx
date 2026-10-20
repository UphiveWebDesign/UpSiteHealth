"use client";

import { useActionState } from "react";
import { Button, Field, FormError } from "@/components/ui/form";
import { signup } from "../actions";

export function SignupForm() {
  const [state, action, pending] = useActionState(signup, undefined);
  return (
    <form action={action} className="flex flex-col gap-4">
      <FormError>{state?.error}</FormError>
      <Field
        label="Your name"
        name="name"
        autoComplete="name"
        required
        errors={state?.fieldErrors?.name}
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        defaultValue={state?.email}
        errors={state?.fieldErrors?.email}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        required
        errors={state?.fieldErrors?.password}
      />
      <Field
        label="Organization name"
        name="organizationName"
        autoComplete="organization"
        required
        errors={state?.fieldErrors?.organizationName}
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
