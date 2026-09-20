import { useEffect, useRef } from "react";
import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { TaskRecord } from "@eve/contracts";
import {
  matchingNoteView,
  type NoteSelectionSnapshot,
} from "../hooks/useNoteContinuity";

const noteHTML = (body: string) =>
  DOMPurify.sanitize(
    body.startsWith("<") ? body : marked.parse(body, { async: false }),
    { USE_PROFILES: { html: true } },
  );

export function NoteEditor({
  task,
  dirty,
  active,
  onChange,
  onViewChange,
  onReady,
}: {
  task: TaskRecord;
  dirty: boolean;
  active: boolean;
  onChange: (body: string) => void;
  onViewChange: (view: NoteSelectionSnapshot) => void;
  onReady: () => void;
}) {
  const latest = useRef({ task, onChange, onViewChange, onReady });
  latest.current = { task, onChange, onViewChange, onReady };
  const boundRevision = useRef<number | null>(task.note.revision);
  const documentBody = useRef<string | null>(null);
  const publish = (editor: Editor) => {
    const { anchor, head, $anchor, $head } = editor.state.selection;
    if (!$anchor.parent.inlineContent || !$head.parent.inlineContent) return;
    documentBody.current ??= editor.getHTML();
    latest.current.onViewChange({
      noteId: latest.current.task.note.id,
      noteRevision: boundRevision.current,
      body: documentBody.current,
      anchor,
      head,
    });
  };
  const editor = useEditor(
    {
      extensions: [StarterKit],
      content: noteHTML(task.note.body),
      editorProps: {
        attributes: {
          class: "note-content",
          "aria-label": "Task note",
          "aria-multiline": "true",
          role: "textbox",
          "data-testid": "note-editor",
          "data-note-task": task.id,
        },
      },
      onCreate: ({ editor }) => {
        documentBody.current = editor.getHTML();
        boundRevision.current = latest.current.task.note.revision;
        const saved = matchingNoteView(latest.current.task);
        if (saved)
          editor.commands.setTextSelection({
            from: saved.selection.anchor,
            to: saved.selection.head,
          });
        publish(editor);
        latest.current.onReady();
      },
      onUpdate: ({ editor }) => {
        documentBody.current = editor.getHTML();
        boundRevision.current = null;
        latest.current.onChange(documentBody.current);
        publish(editor);
      },
      onSelectionUpdate: ({ editor }) => publish(editor),
    },
    [task.id],
  );
  const format = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive("bold") ?? false,
      italic: editor?.isActive("italic") ?? false,
      bulletList: editor?.isActive("bulletList") ?? false,
      canUndo: editor?.can().undo() ?? false,
    }),
  });
  useEffect(() => {
    if (active && editor)
      editor.commands.focus(undefined, { scrollIntoView: false });
  }, [active, editor]);
  useEffect(() => {
    if (!editor || dirty) return;
    const next = noteHTML(task.note.body);
    const current = editor.getHTML();
    if (next !== current) {
      // A different durable document starts its own selection. A saved cursor
      // from an older revision is never replayed into externally changed text.
      const focused = editor.isFocused;
      documentBody.current = null;
      boundRevision.current = task.note.revision;
      editor.commands.setContent(next, { emitUpdate: false });
      if (focused) editor.commands.focus(undefined, { scrollIntoView: false });
    }
    documentBody.current = editor.getHTML();
    boundRevision.current = task.note.revision;
    publish(editor);
  }, [editor, task.note.revision, task.note.body, dirty]);
  return (
    <div className="note-editor">
      <EditorContent editor={editor} />
      <div className="note-tools" role="group" aria-label="Note formatting">
        <button
          className={format?.bold ? "active" : ""}
          aria-label="Bold"
          aria-pressed={format?.bold ?? false}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <strong>B</strong>
        </button>
        <button
          className={format?.italic ? "active" : ""}
          aria-label="Italic"
          aria-pressed={format?.italic ?? false}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <em>I</em>
        </button>
        <span aria-hidden="true" />
        <button
          className={format?.bulletList ? "active" : ""}
          aria-pressed={format?.bulletList ?? false}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          List
        </button>
        <button
          disabled={!format?.canUndo}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          Undo
        </button>
      </div>
    </div>
  );
}
