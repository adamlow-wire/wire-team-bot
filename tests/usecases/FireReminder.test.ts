import { describe, it, expect, vi } from "vitest";
import { FireReminder } from "../../src/application/usecases/reminders/FireReminder";

function setup() {
  let reminder = { id: "REM-1", status: "pending", deleted: false, version: 1, conversationId: { id: "c", domain: "d" }, triggerAt: new Date(0), description: "check deploy" };
  const repo = { findById: vi.fn(async () => reminder), update: vi.fn(async r => { reminder = r; }) };
  const wire = { sendPlainText: vi.fn().mockResolvedValue(undefined) };
  const audit = { append: vi.fn() };
  const scheduler = { schedule: vi.fn(), cancel: vi.fn() };
  const useCase = new FireReminder(repo as never, wire as never, audit, { id: "bot", domain: "d" }, scheduler);
  return { repo, wire, audit, scheduler, useCase };
}
describe("reminder recovery", () => {
  it("leaves a failed send pending, schedules retry and records success only after delivery", async () => {
    const { repo, wire, audit, scheduler, useCase } = setup();
    wire.sendPlainText.mockRejectedValueOnce(new Error("send failed"));
    await expect(useCase.execute({ reminderId: "REM-1" })).rejects.toThrow();
    expect(repo.update).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    expect(scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({ id: "rem-REM-1", type: "reminder" }));
    await useCase.execute({ reminderId: "REM-1" });
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ status: "fired" }));
    await useCase.execute({ reminderId: "REM-1" });
    expect(wire.sendPlainText).toHaveBeenCalledTimes(2);
  });
  it("suppresses concurrent callbacks", async () => {
    const { wire, useCase } = setup();
    await Promise.all([useCase.execute({ reminderId: "REM-1" }), useCase.execute({ reminderId: "REM-1" })]);
    expect(wire.sendPlainText).toHaveBeenCalledOnce();
  });
  it("respects snooze overtaking an old callback", async () => {
    const { repo, wire, scheduler, useCase } = setup();
    await repo.update({ ...await repo.findById(), triggerAt: new Date(Date.now() + 10000) });
    await useCase.execute({ reminderId: "REM-1" });
    expect(wire.sendPlainText).not.toHaveBeenCalled();
    expect(scheduler.schedule).toHaveBeenCalled();
  });
});
