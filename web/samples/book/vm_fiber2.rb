# Fiber の transfer と状態のエラー（VM の仕組みの章）
def t(name)
  print "#{name}: "
  yield
rescue Exception => e
  puts "#{e.class}: #{e.message}"
end
t("current") do
  f = Fiber.new { Fiber.current }
  c = f.resume
  p [c.equal?(f), f.alive?, Fiber.current.class]
end
t("transfer") do
  log = []
  f2 = nil
  f1 = Fiber.new do |x|
    log << [:f1, x]
    y = f2.transfer(:to2)          # f2 へ移り、f2 から transfer で戻ってくる
    log << [:f1_back, y]
    :f1_done
  end
  f2 = Fiber.new { |x| log << [:f2, x]; f1.transfer(:to1) }
  r = f1.transfer(:start)
  p [log, r, f1.alive?, f2.alive?]
end
t("yield in transferred") do
  f = Fiber.new { Fiber.yield :y }
  f.transfer
end
t("resume transferred") do
  f2 = nil
  f1 = Fiber.new { f2.transfer; :never }   # f2 へ移った f1 は TRANSFERRED
  f2 = Fiber.new { f1.resume }             # それを resume しようとする
  f1.transfer
end
t("root yield") { Fiber.yield }
t("resume self") { f = Fiber.new { f.resume }; f.resume }
t("dead") { f = Fiber.new { }; f.resume; f.resume }
t("exception") do
  f = Fiber.new { raise "in fiber" }
  begin; f.resume; rescue => e; p [e.message, f.alive?]; end
end
t("nested") do
  outer = Fiber.new do
    inner = Fiber.new { Fiber.yield :i1; :i2 }
    a = inner.resume
    b = Fiber.yield [:o, a]
    [b, inner.resume]
  end
  p [outer.resume, outer.resume(:x)]
end
