import { CoreStore } from "@eve/core";
import {
  BackupError,
  type RelocationContext,
  type RelocationReceipt,
} from "../../../packages/backup/src/index";
import { relocateProfileFiles } from "./profile-files-relocation";

/** Trusted restore callback: combines independent core and metadata validation. */
export async function relocateEveProfile(
  context: RelocationContext,
): Promise<RelocationReceipt> {
  const database = await CoreStore.relocateDatabase({
    stagingProfile: context.stagingProfile,
    destinationProfile: context.destinationProfile,
    originalProfileRoot: context.originalProfileRoot,
    expectedSchemaVersion: context.manifest.versions.schema,
    includedFiles: context.manifest.files,
    includedDirectories: context.manifest.directories,
    signal: context.signal,
  });
  for (const project of database.projects) {
    if (
      !project.external &&
      !database.references.some(
        (reference) =>
          reference.field === project.referenceField && reference.included,
      )
    ) {
      throw new BackupError(
        "RELOCATION_REQUIRED",
        "A saved project folder is missing from this backup. Its original archive and profile were not changed.",
      );
    }
  }
  const files = await relocateProfileFiles(context, {
    assets: database.assets.map((asset) => asset.after),
    projectBindings: database.projects.map(({ projectId, before, after }) => ({ projectId, before, after })),
  });
  const validated = new Set(files.validatedFiles);
  for (const metadata of database.remainingMetadata) {
    if (!validated.has(metadata.path))
      throw new BackupError(
        "RELOCATION_REQUIRED",
        "This backup contains saved details that this version of Eve cannot restore yet.",
      );
  }
  return {
    validated: true,
    changedFiles: [
      ...new Set([...database.changedFiles, ...files.changedFiles]),
    ],
    notes: [
      ...new Set([
        ...database.notes.filter(
          (note) =>
            !note.startsWith(
              "Core DB validation does not validate import manifests",
            ),
        ),
        ...files.notes,
        "AI connection details and website sign-ins were not restored. Set them up again before connecting.",
        "Choose Recover drafts to open saved code drafts. Unfinished edits, project scripts and AI requests were not restarted.",
      ]),
    ],
  };
}
