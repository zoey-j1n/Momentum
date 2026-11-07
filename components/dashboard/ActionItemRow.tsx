"use client";
// One action item: avatar, task, Owner select, Confirm. Calls setAssigneeAction (Zoey writes setAssignee).
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setAssigneeAction, setItemFlagsAction, type ActionResult } from "@/app/dashboard/actions";
import { isUnassignedOwner, ownerCandidates } from "@/lib/analysis/matchAssignees";

export type ItemView = {
  id: string;
  task: string;
  assigneeId: string | null;
  assigneeName: string; // what the model said, verbatim
  assignmentSource: "THREAD_ID" | "THREAD_NAME" | "NAME_MATCH" | "MANUAL" | "NONE";
  assigneeConfirmed: boolean;
  include: boolean; // goes into the Next steps post
  done: boolean;
  announced: boolean; // already posted in a Next steps message
};
export type UserOption = { id: string; displayName: string };

const SOURCE_LABEL: Record<ItemView["assignmentSource"], string> = {
  THREAD_ID: "from the thread",
  THREAD_NAME: "named in the thread",
  NAME_MATCH: "matched by name",
  MANUAL: "set by reviewer",
  NONE: "",
};

export function ActionItemRow({ item, users }: { item: ItemView; users: UserOption[] }) {
  const router = useRouter();
  const [value, setValue] = useState(item.assigneeId ?? "");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const chosen = users.find((u) => u.id === value);
  const initials = (chosen?.displayName ?? "?").split(/[\s.]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const dirty = value !== (item.assigneeId ?? "");
  // Why there is no owner, in words that say what to do (decision #10): unassigned, nobody by that name, or several.
  const candidates = !item.assigneeId && !isUnassignedOwner(item.assigneeName) ? ownerCandidates(item.assigneeName, users) : [];
  const hint = item.assigneeId ? null
    : isUnassignedOwner(item.assigneeName) ? "No owner yet."
    : candidates.length === 0 ? `Nobody in the workspace is called “${item.assigneeName}”. Pick an owner.`
    : `${candidates.length} people match “${item.assigneeName}”: ${candidates.map((c) => c.displayName).join(", ")}. Pick one.`;
  // Ambiguous names: list the matching people first in the picker.
  const ordered = candidates.length >= 2 ? [...candidates, ...users.filter((u) => !candidates.includes(u))] : users;

  function save() {
    setResult(null);
    start(async () => {
      const r = await setAssigneeAction(item.id, value || null);
      setResult(r);
      if (r.ok) router.refresh();
    });
  }
  function flag(flags: { include?: boolean; done?: boolean }) {
    setResult(null);
    start(async () => {
      const r = await setItemFlagsAction(item.id, flags);
      setResult(r);
      if (r.ok) router.refresh();
    });
  }

  // One grid per row with FIXED column widths, so the checkboxes, owner picker, and button line up
  // across rows regardless of how long each task is. The task column is the only one that flexes.
  return (
    <div className="item-row">
      <span className="avatar">{item.assigneeId ? initials : "?"}</span>
      <span style={{ fontSize: 14, minWidth: 0, textDecoration: item.done ? "line-through" : undefined, color: item.done ? "var(--text-3)" : undefined }}>
        {item.task}{item.announced ? <span className="meta" style={{ marginLeft: 8 }}>announced</span> : null}
      </span>
      <label className="meta item-check" title="Include in the Next steps post">
        <input type="checkbox" checked={item.include} disabled={pending || item.announced} onChange={(e) => flag({ include: e.target.checked })} /> Include
      </label>
      <label className="meta item-check" title="Mark done">
        <input type="checkbox" checked={item.done} disabled={pending} onChange={(e) => flag({ done: e.target.checked })} /> Done
      </label>
      <label className="meta item-owner">
        Owner
        <select className={`select ${!value ? "select-warn" : ""}`} value={value} onChange={(e) => setValue(e.target.value)} disabled={pending} style={{ width: "100%", minWidth: 0 }}>
          <option value="">{item.assigneeId ? "No owner" : "Pick an owner"}</option>
          {ordered.map((u) => (
            <option key={u.id} value={u.id}>{u.displayName}{u.id === item.assigneeId && item.assignmentSource !== "MANUAL" ? ` · ${SOURCE_LABEL[item.assignmentSource]}` : ""}</option>
          ))}
        </select>
      </label>
      <button type="button" className="btn btn-sm" style={{ justifySelf: "stretch" }} disabled={pending || (!dirty && item.assigneeConfirmed)} onClick={save}>
        {item.assigneeConfirmed && !dirty ? "Confirmed" : dirty ? "Save" : "Confirm"}
      </button>
      {hint ? <span className="meta item-note">{hint}</span> : null}
      {result && !result.ok ? <div className="error-line item-note">{result.error}</div> : null}
    </div>
  );
}
