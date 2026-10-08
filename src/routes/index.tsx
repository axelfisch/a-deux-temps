import { createFileRoute } from "@tanstack/react-router";
import { HomeApp } from "@/components/HomeApp";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <HomeApp />;
}
