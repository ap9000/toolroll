import { TextField } from "@standing-orders/design";

export function Default() {
  return (
    <div style={{ maxWidth: 320, background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <TextField label="Task title" placeholder="Fix flaky auth test" />
    </div>
  );
}

export function MonoMachineFact() {
  return (
    <div style={{ maxWidth: 320, background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <TextField
        label="Repository"
        mono
        defaultValue="~/Documents/my-tool"
        hint="Cloned under your project root"
      />
    </div>
  );
}

export function Password() {
  return (
    <div style={{ maxWidth: 320, background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <TextField label="Password" type="password" hint="Signs exactly the terms shown above" />
    </div>
  );
}
