-- Answers com.example.hello. Save this file and the next request runs it.
-- The annotations name types `hpy happyview dev` writes into .happyview/types.

---@param input lexicons.com.example.hello.Params
---@param ctx happyview.QueryCtx
---@return lexicons.com.example.hello.Output
function handle(input, ctx)
  return { message = "Hello, " .. (input.name or "world") .. "!" }
end
