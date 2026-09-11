f = Fiber.new { 3.times { Fiber.yield :t } ; :done }
p f.resume
f2 = Fiber.new { [3,1,2].sort { |a,b| Fiber.yield :s; a <=> b } }
begin; p f2.resume; rescue => e; p e.class, e.message; end
f3 = Fiber.new { "ab".each_char { |c| Fiber.yield c } }
begin; p f3.resume; rescue => e; p e.class, e.message; end
f4 = Fiber.new { {a: 1}.each { |k, v| Fiber.yield k } }
begin; p f4.resume; rescue => e; p e.class, e.message; end
