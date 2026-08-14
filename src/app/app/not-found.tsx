import { Card, NotFoundState } from "@/components/ui";

export default function ProductNotFound() {
  return (
    <div className="product-page product-page--narrow">
      <Card>
        <NotFoundState />
      </Card>
    </div>
  );
}
