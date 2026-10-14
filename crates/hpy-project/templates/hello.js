// Answers com.example.hello. Save this file and the next request runs it.
export default function handle(input, ctx) {
  return { message: `Hello, ${input.name ?? "world"}!` };
}
