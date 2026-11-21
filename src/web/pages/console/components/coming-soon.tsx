/**
 * OPS1: the placeholder for a console section whose phase has not landed yet. A section's builder replaces the whole
 * page file that uses it; nothing else needs changing.
 */
import { Card, EmptyState, PageHeader } from "@/web/components/ui/misc";
import { IconHourglass } from "@/web/components/ui/icon";

export function ComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-6" data-testid="console-coming-soon">
      <PageHeader title={title} description={description} />
      <Card className="p-0">
        <EmptyState icon={<IconHourglass />} title="Coming soon" body="This part of the operator console is being built. Until then, use the Overview for the controls that exist today." />
      </Card>
    </div>
  );
}
