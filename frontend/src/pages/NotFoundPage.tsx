import { Link } from "react-router";
import { PageHeading } from "../components/PageHeading";
import { useDocumentTitle } from "../lib/useDocumentTitle";

export function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <>
      <PageHeading>Page not found</PageHeading>
      <p>
        <Link className="link-action" to="/">Back to all courses</Link>
      </p>
    </>
  );
}
