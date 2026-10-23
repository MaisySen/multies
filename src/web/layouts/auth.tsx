import { Link, Outlet } from "react-router";
import { Logo } from "@/web/components/logo";

export function AuthLayout() {
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-5 py-12">
      <div className="grid-bg pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" aria-hidden />
      <div className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/20 blur-[120px]" aria-hidden />
      <main className="relative w-full max-w-[400px]">
        <Link to="/" className="mb-8 flex justify-center" aria-label="MyMail home"><Logo /></Link>
        <Outlet />
      </main>
    </div>
  );
}
