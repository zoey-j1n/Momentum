"use client";
// One action item: avatar, task, Owner select, Confirm. Calls setAssigneeAction (Zoey writes setAssignee).
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setAssigneeAction, type ActionResult } from "@/app/dashboard/actions";

export type ItemView = {
  id: string;
  task: string;
  assigneeId: string | null;
  assigneeName: string; // what the model said, verbatim
  assignmentSource: "THREAD_ID" | "THREAD_NAME" | "NAME_MATCH" | "MANUAL" | "NONE";
  assigneeConfirmed: boolean;
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

  function save() {
    setResult(null);
    start(async () => {
      const r = await setAssigneeAction(item.id, value || null);
      setResult(r);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <span className="avatar">{item.assigneeId ? initials : "?"}</span>
        <span style={{ flex: "1 1 240px", fontSize: 14 }}>{item.task}</span>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }} className="meta">
          Owner
          <select className={`select ${!value ? "select-warn" : ""}`} value={value} onChange={(e) => setValue(e.target.value)} disabled={pending}>
            <option value="">{item.assigneeId ? "No owner" : "Pick an owner"}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.displayName}{u.id === item.assigneeId && item.assignmentSource !== "MANUAL" ? ` · ${SOURCE_LABEL[item.assignmentSource]}` : ""}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-sm" disabled={pending || (!dirty && item.assigneeConfirmed)} onClick={save}>
          {item.assigneeConfirmed && !dirty ? "Confirmed" : dirty ? "Save" : "Confirm"}
        </button>
      </div>
      {!item.assigneeId && item.assigneeName ? <span className="meta" style={{ paddingLeft: 36 }}>The model said “{item.assigneeName}”, which did not match exactly one person.</span> : null}
      {result && !result.ok ? <div className="error-line" style={{ marginLeft: 36 }}>{result.error}</div> : null}
    </div>
  );
}
