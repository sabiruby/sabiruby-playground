def f
  begin
    g
  rescue ArgumentError, TypeError => e
    1
  rescue
    2
  else
    3
  ensure
    h
  end
end
def k
  x = g rescue 0
  x
end
