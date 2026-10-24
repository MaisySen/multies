import { Link, Outlet } from "react-router";
import { Logo } from "@/web/components/logo";

export function AuthLayout() {
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-5 py-12">
      <main className="relative w-full max-w-[400px]">
        <Link to="/" className="mb-8 flex justify-center" aria-label="Multies home"><Logo /></Link>
        <Outlet />
      </main>
    </div>
  );
}
