import type { Metadata } from "next";
import { ActionForm, inputClass } from "@/components/ui/action-form";
import { Card, PageHeader } from "@/components/ui/layout";
import { requireUser } from "@/lib/auth/dal";
import { changePasswordAction } from "./actions";

export const metadata: Metadata = { title: "Account · UpSiteHealth" };

export default async function AccountPage() {
  const user = await requireUser();
  return (
    <>
      <PageHeader title="Account" subtitle={user.email} />
      <div className="max-w-lg">
        <Card title="Change password">
          <ActionForm
            action={changePasswordAction}
            submitLabel="Change password"
          >
            <label className="text-sm font-medium">
              Current password
              <input
                name="current"
                type="password"
                autoComplete="current-password"
                required
                className={inputClass}
              />
            </label>
            <label className="text-sm font-medium">
              New password
              <input
                name="next"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                className={inputClass}
              />
            </label>
            <label className="text-sm font-medium">
              Confirm new password
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                className={inputClass}
              />
            </label>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
