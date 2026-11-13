"use client";

// Adapted from the assistant-ui `thread-list` element, base-nova registry style.
// Copyright (c) 2026 AgentbaseAI Inc. MIT License. See THIRD_PARTY.md. Changes for Touchstone runs:
// every row has one shape (status mark and title, then scope and module dots),
// date groups read from the run (`custom`), an Archived section, and no Delete
// (runs are evidence).

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ModuleDots } from "@/components/module-dots";
import { RunStatusMark } from "@/components/assistant-ui/elements/indicators";
import type { RunMarkKind } from "@/components/thread-model";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import {
  forwardRef,
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type FC,
} from "react";

// What a run puts in a thread's `custom` field.
export type RunThreadCustom = {
  // The run's status mark (RunStatusMark).
  mark: RunMarkKind;
  // The status word, for screen readers and the row tooltip.
  label: string;
  // Start time in ms, for the Today / Yesterday / Earlier groups.
  at: number;
  running: boolean;
  // A live run cannot be archived; it would cut the agent off.
  canArchive: boolean;
  // The second line: the scope the run used (else its target, else a dash).
  scope: string;
  // Every module the run covers, in the server's order, as dots on the second line.
  modules: { id: string; title: string }[];
};

const runCustom = (custom: Record<string, unknown> | undefined) =>
  custom as RunThreadCustom | undefined;

export const ThreadList: FC = () => {
  const [search, setSearch] = useState("");
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);

  return (
    <ThreadListRoot>
      <ThreadListNew />
      {hasThreads && (
        <ThreadListSearch value={search} onValueChange={setSearch} />
      )}
      <ThreadListItems searchQuery={hasThreads ? search : ""} />
      <ThreadListArchived />
    </ThreadListRoot>
  );
};

export const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange"> & {
    value: string;
    onValueChange: (value: string) => void;
  }
>(({ className, value, onValueChange, ...props }, ref) => {
  return (
    <div data-slot="aui_thread-list-search" className="relative px-0.5 py-1">
      <SearchIcon
        data-slot="aui_thread-list-search-icon"
        className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
      />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-label="Search runs"
        placeholder="Search runs"
        className={cn("h-8 ps-8 text-sm", className)}
        {...props}
      />
    </div>
  );
});

ThreadListSearch.displayName = "ThreadListSearch";

export const ThreadListRoot: FC<
  ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>
> = ({ className, ...props }) => {
  return (
    <ThreadListPrimitive.Root
      data-slot="aui_thread-list-root"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  );
};

export const ThreadListItems: FC<
  ComponentPropsWithoutRef<"div"> & { searchQuery?: string }
> = ({ className, searchQuery = "", ...props }) => {
  return (
    <div
      data-slot="aui_thread-list-items"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    >
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListItemGroups searchQuery={searchQuery} />
      </AuiIf>
    </div>
  );
};

const dateGroupLabel = (
  time: number | undefined,
  startOfToday: number,
  startOfYesterday: number,
): string => {
  if (!time || time >= startOfToday) return "Today";
  if (time >= startOfYesterday) return "Yesterday";
  return "Earlier";
};

const startOfLocalDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const subscribeToNextDay = (onDayChange: () => void) => {
  let timeout: number;
  const scheduleNextDay = () => {
    const now = new Date();
    const startOfTomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    ).getTime();
    timeout = window.setTimeout(() => {
      onDayChange();
      scheduleNextDay();
    }, startOfTomorrow - now.getTime());
  };
  scheduleNextDay();
  return () => window.clearTimeout(timeout);
};

const getStartOfToday = () => startOfLocalDay(new Date());

const useStartOfToday = () =>
  useSyncExternalStore<number | undefined>(
    subscribeToNextDay,
    getStartOfToday,
    () => undefined,
  );

type ThreadListGroup = { label: string; indices: number[] };

/**
 * Filters the run list by title and buckets the matches by start time
 * (Today, Yesterday, Earlier). `groups` is null when no run carries a time.
 */
const useThreadListGroups = (searchQuery = "") => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);

  const query = searchQuery.trim().toLowerCase();
  const startOfToday = useStartOfToday();

  return useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const times = threadIds.map((id) => runCustom(itemsById.get(id)?.custom)?.at);
    const filteredIndices = threadIds
      .map((id, index) => ({ id, index }))
      .filter(
        ({ id }) =>
          !query ||
          (itemsById.get(id)?.title || "Untitled run")
            .toLowerCase()
            .includes(query),
      )
      .map(({ index }) => index);
    if (
      startOfToday === undefined ||
      !filteredIndices.some((index) => times[index])
    ) {
      return { threadIds, filteredIndices, groups: null };
    }

    const yesterday = new Date(startOfToday);
    yesterday.setDate(yesterday.getDate() - 1);
    const startOfYesterday = yesterday.getTime();
    const time = (index: number) => times[index] ?? Number.MAX_SAFE_INTEGER;
    const sorted = [...filteredIndices].sort((a, b) => time(b) - time(a));

    const result: ThreadListGroup[] = [];
    for (const index of sorted) {
      const label = dateGroupLabel(times[index], startOfToday, startOfYesterday);
      const lastGroup = result[result.length - 1];
      if (lastGroup?.label === label) {
        lastGroup.indices.push(index);
      } else {
        result.push({ label, indices: [index] });
      }
    }
    return { threadIds, filteredIndices, groups: result };
  }, [threadIds, threadItems, query, startOfToday]);
};

const ThreadListItemGroups: FC<{ searchQuery?: string }> = ({
  searchQuery = "",
}) => {
  const { threadIds, filteredIndices, groups } =
    useThreadListGroups(searchQuery);
  const query = searchQuery.trim();

  if (query && filteredIndices.length === 0) {
    return (
      <div
        data-slot="aui_thread-list-empty"
        className="text-muted-foreground px-2.5 py-4 text-sm"
      >
        No runs found
      </div>
    );
  }

  if (!groups) {
    return filteredIndices.map((index) => (
      <ThreadListPrimitive.ItemByIndex
        key={threadIds[index]}
        index={index}
        components={{ ThreadListItem }}
      />
    ));
  }

  return groups.map((group) => (
    <Fragment key={group.label}>
      <div
        data-slot="aui_thread-list-group-label"
        className="text-muted-foreground px-2.5 pt-3 pb-1 text-xs font-medium"
      >
        {group.label}
      </div>
      {group.indices.map((index) => (
        <ThreadListPrimitive.ItemByIndex
          key={threadIds[index]}
          index={index}
          components={{ ThreadListItem }}
        />
      ))}
    </Fragment>
  ));
};

// Archived runs, folded by default, below the open ones.
export const ThreadListArchived: FC = () => {
  const ids = useAuiState((s) => s.threads.archivedThreadIds);
  if (ids.length === 0) return null;
  return (
    <Collapsible data-slot="aui_thread-list-archived" className="mt-2">
      <CollapsibleTrigger className="group/archived text-muted-foreground hover:text-foreground flex h-8 w-full items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-[panel-open]/archived:rotate-90" />
        <span>Archived</span>
        <span className="ms-auto tabular-nums">{ids.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5">
        {ids.map((id, index) => (
          <ThreadListPrimitive.ItemByIndex
            key={id}
            index={index}
            archived
            components={{ ThreadListItem }}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
};

export const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button> & { labelClassName?: string }
>(({ className, labelClassName, children, ...props }, ref) => {
  return (
    <ThreadListPrimitive.New asChild>
      <Button
        ref={ref}
        variant="ghost"
        data-slot="aui_thread-list-new"
        className={cn(
          "hover:bg-muted data-active:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <PlusIcon
              data-slot="aui_thread-list-new-icon"
              className="size-4 shrink-0"
            />
            <span
              data-slot="aui_thread-list-new-label"
              className={cn("whitespace-nowrap", labelClassName)}
            >
              New run
            </span>
          </>
        )}
      </Button>
    </ThreadListPrimitive.New>
  );
});

ThreadListNew.displayName = "ThreadListNew";

const ThreadListSkeleton: FC = () => {
  return (
    <div
      role="status"
      aria-label="Loading runs"
      className="flex flex-col gap-0.5"
    >
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          data-slot="aui_thread-list-skeleton-wrapper"
          className="flex h-12 flex-col justify-center gap-1.5 px-2.5"
        >
          <Skeleton
            data-slot="aui_thread-list-skeleton"
            className="h-3.5 w-full"
          />
          <Skeleton className="ms-[22px] h-3 w-2/5" />
        </div>
      ))}
    </div>
  );
};

// One shape for every run, so every entry is the same height and the title
// starts at the same x: the status mark (one size in every state), the title on
// one line and the room for the "…" menu, always kept; under it the scope on
// the left and the module dots on the right. Nothing wraps; nothing moves on
// hover. The dots sit beside the row button, not in it (one control may not
// hold another), like the "…" menu.
export const ThreadListItem: FC = () => {
  const run = useAuiState((s) => runCustom(s.threadListItem.custom));
  const [isRenaming, setIsRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (isRenaming || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [isRenaming]);

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      className={cn(
        "group hover:bg-muted focus-visible:bg-muted data-active:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted relative flex h-12 items-center rounded-md transition-colors focus-visible:outline-none",
        // The module dots' ring takes the row's own surface.
        "[--module-dots-ring:var(--sidebar)] hover:[--module-dots-ring:var(--muted)] data-active:[--module-dots-ring:var(--muted)] has-focus-visible:[--module-dots-ring:var(--muted)] has-data-[state=open]:[--module-dots-ring:var(--muted)]",
      )}
    >
      {isRenaming ? (
        <ThreadListItemRename
          onDone={(restoreFocus) => {
            restoreFocusRef.current = restoreFocus;
            setIsRenaming(false);
          }}
        />
      ) : (
        <ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          data-slot="aui_thread-list-item-trigger"
          title={run?.label}
          className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-md ps-2.5 pe-9 text-start outline-none focus-visible:ring-1"
        >
          <span className="flex h-5 min-w-0 items-center gap-2">
            {run ? (
              <RunStatusMark aria-hidden kind={run.mark} label={run.label} />
            ) : (
              <span aria-hidden className="size-3.5 shrink-0" />
            )}
            <span
              data-slot="aui_thread-list-item-title"
              className="min-w-0 flex-1 truncate text-sm"
            >
              <ThreadListItemPrimitive.Title fallback="Untitled run" />
            </span>
          </span>
          {/* Under the title, beside the dots' fixed box (right). */}
          <span
            data-slot="aui_thread-list-item-scope"
            className="text-muted-foreground ms-[22px] me-1 block h-4 min-w-0 truncate text-xs leading-4"
          >
            {run?.scope ?? "—"}
          </span>
          {run && <span className="sr-only">{run.label}</span>}
        </ThreadListItemPrimitive.Trigger>
      )}
      {run && !isRenaming ? (
        <span className="absolute end-2.5 bottom-[7px] flex">
          {/* The names open right, past the rail, level with the dots, so they
              never cover this title or the rows above. The dots end 19 px
              inside the rail's edge (measured at 1440: 237 against 256); 8 px
              more is the usual gap. On a phone the tooltip flips or shifts to
              fit the screen. */}
          <ModuleDots ids={run.modules.map((m) => m.id)} packs={run.modules} side="right" sideOffset={27} />
        </span>
      ) : null}
      <ThreadListItemMore
        canArchive={run?.canArchive ?? false}
        onRename={() => setIsRenaming(true)}
      />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemRename: FC<{
  onDone: (restoreFocus: boolean) => void;
}> = ({ onDone }) => {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) ?? "";
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = (restoreFocus: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;

    const next = value.trim();
    if (!next || next === title) {
      onDone(restoreFocus);
      return;
    }

    // Deferred so a synchronous throw lands on the rejection path too.
    Promise.resolve()
      .then(() => aui.threadListItem.rename(next))
      .then(
        () => onDone(restoreFocus),
        () => {
          settledRef.current = false;
          if (restoreFocus) inputRef.current?.focus();
        },
      );
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onDone(true);
  };

  return (
    <Input
      ref={inputRef}
      autoFocus
      data-slot="aui_thread-list-item-rename"
      aria-label="Rename run"
      value={value}
      className="h-7 min-w-0 flex-1 ps-2.5 pe-9 text-sm"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
};

const MORE_ITEM =
  "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none";

const ThreadListItemMore: FC<{ canArchive: boolean; onRename: () => void }> = ({
  canArchive,
  onRename,
}) => {
  const archived = useAuiState((s) => s.threadListItem.status === "archived");
  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-slot="aui_thread-list-item-more"
          className="data-[state=open]:bg-accent absolute end-1.5 top-[5px] size-6 p-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
          <span className="sr-only">More options</span>
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        data-slot="aui_thread-list-item-more-content"
        className="bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 overflow-hidden rounded-xl border p-1.5"
      >
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className={MORE_ITEM}
          onSelect={onRename}
        >
          <PencilIcon className="size-4" />
          Rename
        </ThreadListItemMorePrimitive.Item>
        {archived ? (
          <ThreadListItemPrimitive.Unarchive asChild>
            <ThreadListItemMorePrimitive.Item
              data-slot="aui_thread-list-item-more-item"
              className={MORE_ITEM}
            >
              <ArchiveRestoreIcon className="size-4" />
              Unarchive
            </ThreadListItemMorePrimitive.Item>
          </ThreadListItemPrimitive.Unarchive>
        ) : canArchive ? (
          <ThreadListItemPrimitive.Archive asChild>
            <ThreadListItemMorePrimitive.Item
              data-slot="aui_thread-list-item-more-item"
              className={MORE_ITEM}
            >
              <ArchiveIcon className="size-4" />
              Archive
            </ThreadListItemMorePrimitive.Item>
          </ThreadListItemPrimitive.Archive>
        ) : null}
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
