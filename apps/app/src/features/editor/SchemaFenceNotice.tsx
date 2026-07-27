/**
 * SchemaFenceNotice — minimal writer copy for a fenced editor session.
 *
 * Deliberately unstyled until the writer-visible fence surface lands.
 */
import { Trans } from "@lingui/react/macro";

import type { SchemaFence } from "@/core/editor/schema-fence";

export type SchemaFenceNoticeProps = {
  fence: SchemaFence;
};

export function SchemaFenceNotice({ fence }: SchemaFenceNoticeProps) {
  return (
    <p data-schema-fence data-schema-fence-reason={fence.reason}>
      {fence.reason === "client-superseded" ? (
        <Trans>
          This chapter was opened in a newer version of Meridian. Refresh to keep writing.
        </Trans>
      ) : null}
      {fence.reason === "invalid-content" ? (
        <Trans>
          Part of this chapter can't be opened safely in this version of Meridian. Editing is paused
          to protect your manuscript. Refresh to try again.
        </Trans>
      ) : null}
      {fence.reason === "repair-detected" ? (
        <Trans>
          Part of this chapter couldn't be kept in this version of Meridian. Editing is paused to
          protect your manuscript. Refresh to continue.
        </Trans>
      ) : null}
    </p>
  );
}
