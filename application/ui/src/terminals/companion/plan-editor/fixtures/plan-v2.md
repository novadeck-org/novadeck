# A home for Studio

Build a lightweight site that introduces the studio, presents selected work, and gives potential collaborators a clear way to get in touch.

## Direction

Let the work lead. Pair generous space with a confident grotesk for headlines, quiet navigation, and a warm ivory background.

> The interface should feel like a well-edited publication: calm, deliberate, and worth spending time with.

## Scope

| Page    | What it needs to do                                                 |
| ------- | ------------------------------------------------------------------- |
| Home    | Introduce the practice and lead into three selected projects.       |
| Project | Show the brief, approach, and outcome with a generous image layout. |
| About   | Explain how the studio works and offer a simple contact link.       |

## Steps

1. [ ] **Set the foundations.** Colour, type, and spacing tokens in `styles/tokens.css`; shared navigation and footer.
2. [ ] **Build the home page** in `pages/Home.tsx`: introduction, one featured project at full width, then a short contact section.
3. [ ] **Create the project template** in `pages/Project.tsx`, with content kept in `content/projects.ts`.
4. [ ] **Refine the smaller layouts.** Stack the project grid on mobile and keep reading widths comfortable.
5. [ ] **Add a Journal page** in `pages/Journal.tsx` for short studio notes.

## Structure

```
src/
  components/  Navigation, Footer, ProjectCard
  pages/       Home, Project, About
  content/     Project descriptions and image references
  styles/      Tokens and shared layout rules
```

Out of scope for this pass: CMS, contact forms, analytics, and deployment.
