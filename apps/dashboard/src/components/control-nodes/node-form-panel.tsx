'use client';

import { Loader2, Wifi, WifiOff } from 'lucide-react';
import { FormField, inputClass } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';

export type FormMode = 'create' | 'edit';
export type TestResult = 'idle' | 'testing' | 'ok' | 'fail';

interface NodeFormPanelProps {
  formMode: FormMode;

  // Shared fields
  name: string;
  setName: (v: string) => void;
  apiSecret: string;
  setApiSecret: (v: string) => void;
  hasStoredApiSecret: boolean;

  // Create-mode fields
  hostname: string;
  setHostname: (v: string) => void;
  controlApiPort: string;
  setControlApiPort: (v: string) => void;

  // Edit-mode fields
  url: string;
  setUrl: (v: string) => void;

  // State
  saving: boolean;
  testResult: TestResult;

  // Callbacks
  onTestConnection: () => void;
  onSave: () => void;
  onCancel: () => void;
}

export function NodeFormPanel({
  formMode,
  name,
  setName,
  apiSecret,
  setApiSecret,
  hasStoredApiSecret,
  hostname,
  setHostname,
  controlApiPort,
  setControlApiPort,
  url,
  setUrl,
  saving,
  testResult,
  onTestConnection,
  onSave,
  onCancel,
}: NodeFormPanelProps): React.ReactElement {
  return (
    <div className="space-y-4">
      {formMode === 'create' ? (
        <>
          <FormField label="Hostname" required>
            <input
              type="text"
              className={inputClass}
              placeholder="e.g. magnus.example.com"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
            />
          </FormField>

          <FormField label="Name">
            <input
              type="text"
              className={inputClass}
              placeholder={hostname.trim() || 'Defaults to hostname'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>

          <div className="grid grid-cols-1 gap-3">
            <FormField label="Control Port">
              <input
                type="text"
                className={inputClass}
                placeholder="4000"
                value={controlApiPort}
                onChange={(e) => setControlApiPort(e.target.value)}
              />
            </FormField>
          </div>

          {hostname.trim() && (
            <div className="rounded border border-border bg-bg/50 px-3 py-2 text-xs text-text-muted">
              URL:{' '}
              <span className="text-text">
                https://{hostname.trim()}:{parseInt(controlApiPort, 10) || 4000}
              </span>
            </div>
          )}

          <FormField label="Control API Credential">
            <input
              type="password"
              className={inputClass}
              placeholder={hasStoredApiSecret ? 'Leave blank to keep stored credential' : 'Dedicated Control API credential'}
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
            />
          </FormField>

          <div className="rounded border border-border bg-bg p-3 text-xs text-text-muted">
            This registers an already deployed Control API. Provision hosts with the reviewed key-only release runbook.
          </div>
        </>
      ) : (
        <>
          <FormField label="Name" required>
            <input
              type="text"
              className={inputClass}
              placeholder="e.g. Production East"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>

          <FormField label="URL" required>
            <input
              type="text"
              className={inputClass}
              placeholder="e.g. https://magnus.example.com:4000"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
              }}
            />
          </FormField>

          <FormField label="Control API Credential">
            <input
              type="password"
              className={inputClass}
              placeholder={hasStoredApiSecret ? 'Leave blank to keep stored credential' : 'Dedicated Control API credential'}
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
            />
          </FormField>

        </>
      )}

      {/* Test connection to the already-provisioned endpoint. */}
      <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onTestConnection}
            disabled={
              testResult === 'testing' ||
              (formMode === 'create' ? !hostname.trim() : !url)
            }
            icon={
              testResult === 'testing' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : testResult === 'ok' ? (
                <Wifi className="h-3.5 w-3.5 text-success" />
              ) : testResult === 'fail' ? (
                <WifiOff className="h-3.5 w-3.5 text-danger" />
              ) : (
                <Wifi className="h-3.5 w-3.5" />
              )
            }
          >
            {testResult === 'testing'
              ? 'Testing…'
              : testResult === 'ok'
                ? 'Connected'
                : testResult === 'fail'
                  ? 'Failed'
                  : 'Test Connection'}
          </Button>
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <Button variant="secondary" size="md" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={onSave}
          disabled={saving}
          icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
        >
          {saving ? 'Saving…' : formMode === 'create' ? 'Add Node' : 'Save Changes'}
        </Button>
      </div>
    </div>
  );
}
