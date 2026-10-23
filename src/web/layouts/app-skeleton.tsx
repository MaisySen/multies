export function AppSkeleton() {
  return (
    <div className="flex min-h-dvh" aria-busy="true" aria-label="Loading">
      <div className="hidden w-60 border-r border-line bg-surface p-4 lg:block">
        <div className="skeleton mb-8 h-7 w-28" />
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton mb-3 h-6 w-full" />)}
      </div>
      <div className="flex-1 p-8">
        <div className="skeleton mb-6 h-7 w-48" />
        <div className="grid gap-4 md:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton h-28" />)}</div>
      </div>
    </div>
  );
}
