import { redirect } from "next/navigation";

// The old landing page is retired; the dashboard is the product.
export default function Home() {
  redirect("/dashboard");
}
