f = Fiber.new { |x| y = Fiber.yield(x + 1); y * 2 }
p f.resume(1)
p f.resume(10)
p f.alive?
begin; f.resume; rescue => e; p e.class, e.message; end
