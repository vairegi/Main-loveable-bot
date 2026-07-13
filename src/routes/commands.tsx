import { createFileRoute } from "@tanstack/react-router";
import { COMMAND_CATEGORIES, type CommandDoc } from "@/lib/bot/command-catalog";

export const Route = createFileRoute("/commands")({
  head: () => ({
    meta: [
      { title: "Bot commands — full reference" },
      {
        name: "description",
        content:
          "Complete reference for every Telegram bot command: posting, backups, drip scheduler, moderation, and admin tools.",
      },
      { property: "og:title", content: "Bot commands — full reference" },
      {
        property: "og:description",
        content: "Every Telegram bot command grouped by category, with syntax and examples.",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: CommandsPage,
});

function roleBadge(role: CommandDoc["role"]) {
  if (role === "super") {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
        super-admin
      </span>
    );
  }
  if (role === "admin") {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
        admin
      </span>
    );
  }
  return null;
}

function CommandsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-5 py-12">
        <header className="mb-10">
          <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
            Reference
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            Bot commands
          </h1>
          <p className="mt-3 text-muted-foreground">
            Complete list of every command supported by the bot. Send{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-sm">/help</code>{" "}
            in chat for a compact index scoped to your role.
          </p>

          <nav aria-label="Categories" className="mt-6 flex flex-wrap gap-2">
            {COMMAND_CATEGORIES.map((cat) => (
              <a
                key={cat.slug}
                href={`#${cat.slug}`}
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
              >
                {cat.emoji} {cat.title}
              </a>
            ))}
          </nav>
        </header>

        <div className="space-y-12">
          {COMMAND_CATEGORIES.map((cat) => (
            <section key={cat.slug} id={cat.slug} className="scroll-mt-8">
              <h2 className="mb-4 flex items-center gap-2 border-b border-border pb-2 text-xl font-semibold">
                <span aria-hidden>{cat.emoji}</span>
                {cat.title}
              </h2>
              <ul className="space-y-5">
                {cat.commands.map((cmd) => (
                  <li key={cmd.name} id={`cmd-${cmd.name}`} className="scroll-mt-8">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <code className="text-base font-semibold text-foreground">
                        /{cmd.name}
                        {cmd.syntax ? (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            {cmd.syntax}
                          </span>
                        ) : null}
                      </code>
                      {roleBadge(cmd.role)}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {cmd.description}
                    </p>
                    {cmd.details ? (
                      <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                        {cmd.details}
                      </pre>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="mt-16 border-t border-border pt-6 text-xs text-muted-foreground">
          <p>
            Roles: <span className="text-foreground">user</span> commands work
            for anyone,{" "}
            <span className="text-foreground">admin</span> and{" "}
            <span className="text-foreground">super-admin</span> commands are
            restricted.
          </p>
        </footer>
      </div>
    </div>
  );
}
