def f(x)
  case x
  when 1, 2
    :small
  when String
    :str
  else
    :other
  end
end
