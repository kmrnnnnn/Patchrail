import { Skeleton } from "@/components/ui";

export default function ProductLoading() {
  return (
    <div className="product-page" aria-label="Loading page">
      <div className="loading-header">
        <Skeleton />
        <Skeleton />
      </div>
      <div className="metric-strip loading-metrics">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} />
        ))}
      </div>
      <Skeleton className="loading-panel" />
    </div>
  );
}
